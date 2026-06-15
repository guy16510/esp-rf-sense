#include "NetworkStreamer.h"

#include <cstring>
#include <new>

#include "DeviceHealth.h"
#include "FrameBatch.h"
#include "FrameQueue.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "network_stream";
constexpr uint32_t kFlushIntervalMs = 50;     // finalize a partial datagram after this idle
constexpr uint32_t kPopTimeoutMs = 20;        // encode task wait per frame
constexpr int kEncodeStack = 4096;
constexpr int kNetworkStack = 4096;
constexpr int kPrioEncode = 6;
constexpr int kPrioNetwork = 5;

// Batch ring. Single producer (encode), single consumer (network).
// Push drops the OLDEST batch when full (freshest CSI is preferred for sensing).
class BatchRing {
 public:
  bool init(uint32_t depth) {
    depth_ = depth;
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
    constexpr uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
#else
    constexpr uint32_t caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
#endif
    slots_ = static_cast<FrameBatch*>(heap_caps_malloc(sizeof(FrameBatch) * depth, caps));
    if (!slots_) return false;
    mutex_ = xSemaphoreCreateMutex();
    items_ = xSemaphoreCreateCounting(depth, 0);
    return mutex_ && items_;
  }

  void push(const uint8_t* data, uint16_t len) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    if (count_ == depth_) {
      // drop oldest
      tail_ = (tail_ + 1) % depth_;
      --count_;
      xSemaphoreTake(items_, 0);  // consume one token for the dropped slot
      DeviceHealth::instance().incNetworkQueueDrops();
    }
    FrameBatch& b = slots_[head_];
    b.len = len;
    std::memcpy(b.data, data, len);
    head_ = (head_ + 1) % depth_;
    ++count_;
    xSemaphoreGive(mutex_);
    xSemaphoreGive(items_);
  }

  // Blocks up to timeoutMs for a batch; copies it out. Returns false on timeout.
  bool pop(FrameBatch& out, uint32_t timeoutMs) {
    if (xSemaphoreTake(items_, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) {
      return false;
    }
    xSemaphoreTake(mutex_, portMAX_DELAY);
    out = slots_[tail_];
    tail_ = (tail_ + 1) % depth_;
    --count_;
    xSemaphoreGive(mutex_);
    return true;
  }

 private:
  FrameBatch* slots_ = nullptr;
  uint32_t depth_ = 0;
  uint32_t head_ = 0;
  uint32_t tail_ = 0;
  uint32_t count_ = 0;
  SemaphoreHandle_t mutex_ = nullptr;
  SemaphoreHandle_t items_ = nullptr;
};

}  // namespace

NetworkStreamer& NetworkStreamer::instance() {
  static NetworkStreamer s;
  return s;
}

void NetworkStreamer::configure(uint32_t deviceId, uint32_t bootId) {
  deviceId_ = deviceId;
  bootId_ = bootId;
}

void NetworkStreamer::setTarget(const std::string& host, uint16_t port) {
  host_ = host;
  port_ = port;
  targetResolved_ = false;
}

bool NetworkStreamer::resolveTarget() {
  if (host_.empty() || port_ == 0) {
    return false;
  }
  auto* addr = static_cast<struct sockaddr_in*>(targetAddr_);
  std::memset(addr, 0, sizeof(*addr));
  addr->sin_family = AF_INET;
  addr->sin_port = htons(port_);

  // Try dotted-quad first, then DNS.
  if (inet_aton(host_.c_str(), &addr->sin_addr) == 1) {
    targetResolved_ = true;
    return true;
  }
  struct addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo* res = nullptr;
  if (getaddrinfo(host_.c_str(), nullptr, &hints, &res) != 0 || res == nullptr) {
    return false;
  }
  addr->sin_addr = reinterpret_cast<struct sockaddr_in*>(res->ai_addr)->sin_addr;
  freeaddrinfo(res);
  targetResolved_ = true;
  return true;
}

bool NetworkStreamer::start() {
  if (running_.load()) {
    return true;
  }
  targetAddr_ = heap_caps_malloc(sizeof(struct sockaddr_in), MALLOC_CAP_8BIT);
  if (!targetAddr_) return false;

  auto* ring = new (std::nothrow) BatchRing();
  if (!ring || !ring->init(kBatchQueueDepth)) {
    ESP_LOGE(kTag, "batch ring init failed");
    return false;
  }
  batchRing_ = ring;

  sock_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock_ < 0) {
    ESP_LOGE(kTag, "socket() failed errno=%d", errno);
    return false;
  }
  resolveTarget();  // best-effort; network task retries if it fails now

  running_.store(true);
  xTaskCreate(&NetworkStreamer::encodeTaskTramp, "csi_encode", kEncodeStack, this, kPrioEncode,
              reinterpret_cast<TaskHandle_t*>(&encodeTaskHandle_));
  xTaskCreate(&NetworkStreamer::networkTaskTramp, "csi_net", kNetworkStack, this, kPrioNetwork,
              reinterpret_cast<TaskHandle_t*>(&networkTaskHandle_));
  ESP_LOGI(kTag, "streaming to %s:%u", host_.c_str(), port_);
  return true;
}

void NetworkStreamer::stop() {
  if (!running_.load()) {
    return;
  }
  running_.store(false);
  // Tasks observe running_ == false and self-delete; give them a moment.
  vTaskDelay(pdMS_TO_TICKS(2 * kFlushIntervalMs));
  if (sock_ >= 0) {
    close(sock_);
    sock_ = -1;
  }
  ESP_LOGI(kTag, "streaming stopped");
}

void NetworkStreamer::encodeTaskTramp(void* arg) { static_cast<NetworkStreamer*>(arg)->encodeTask(); }
void NetworkStreamer::networkTaskTramp(void* arg) {
  static_cast<NetworkStreamer*>(arg)->networkTask();
}

void NetworkStreamer::encodeTask() {
  auto* ring = static_cast<BatchRing*>(batchRing_);
  FrameQueue& fq = FrameQueue::instance();
  uint8_t scratch[proto::kMaxDatagramSize];
  proto::DatagramBuilder builder(scratch, sizeof(scratch));

  auto beginDatagram = [&]() {
    proto::DatagramHeader h;
    h.deviceId = deviceId_;
    h.bootId = bootId_;
    h.captureMode = mode_.load(std::memory_order_relaxed);
    h.packetSeq = packetSeq_.fetch_add(1, std::memory_order_relaxed);
    h.batchSeq = batchSeq_.fetch_add(1, std::memory_order_relaxed);
    builder.begin(h);
  };

  beginDatagram();
  uint32_t idleMs = 0;
  while (running_.load()) {
    CsiSlot* slot = fq.popReady(kPopTimeoutMs);
    if (slot == nullptr) {
      idleMs += kPopTimeoutMs;
      if (builder.frameCount() > 0 && idleMs >= kFlushIntervalMs) {
        ring->push(scratch, static_cast<uint16_t>(builder.finalize()));
        beginDatagram();
        idleMs = 0;
      }
      continue;
    }
    idleMs = 0;
    if (!builder.canFit(slot->header.csiLen) && builder.frameCount() > 0) {
      ring->push(scratch, static_cast<uint16_t>(builder.finalize()));
      beginDatagram();
    }
    builder.addFrame(slot->header, slot->csi);
    fq.release(slot);

    DeviceHealth::instance().recordStackEncode(
        static_cast<int32_t>(uxTaskGetStackHighWaterMark(nullptr)));
  }
  vTaskDelete(nullptr);
}

void NetworkStreamer::networkTask() {
  auto* ring = static_cast<BatchRing*>(batchRing_);
  FrameBatch batch;
  uint32_t resolveBackoff = 0;
  while (running_.load()) {
    if (!ring->pop(batch, 100)) {
      continue;
    }
    if (!targetResolved_) {
      if (resolveBackoff == 0) {
        if (!resolveTarget()) {
          resolveBackoff = 20;  // ~2s before retrying name resolution
        }
      } else {
        --resolveBackoff;
      }
      if (!targetResolved_) {
        // Collector address unknown: drop this batch but keep sensing.
        DeviceHealth::instance().incNetworkSendFailures();
        continue;
      }
    }
    auto* addr = static_cast<struct sockaddr_in*>(targetAddr_);
    const int sent = sendto(sock_, batch.data, batch.len, 0,
                            reinterpret_cast<struct sockaddr*>(addr), sizeof(*addr));
    if (sent == batch.len) {
      DeviceHealth::instance().incNetworkBatches();
      DeviceHealth::instance().addNetworkBytes(batch.len);
    } else {
      DeviceHealth::instance().incNetworkSendFailures();
    }
    DeviceHealth::instance().recordStackNetwork(
        static_cast<int32_t>(uxTaskGetStackHighWaterMark(nullptr)));
  }
  vTaskDelete(nullptr);
}

void NetworkStreamer::sendMaintenanceNotice() {
  if (sock_ < 0 || !targetResolved_) {
    return;
  }
  uint8_t buf[proto::kDatagramHeaderSize + proto::kCrcSize];
  proto::DatagramBuilder builder(buf, sizeof(buf));
  proto::DatagramHeader h;
  h.deviceId = deviceId_;
  h.bootId = bootId_;
  h.captureMode = mode_.load(std::memory_order_relaxed);
  h.flags = proto::kFlagMaintenance;
  h.packetSeq = packetSeq_.fetch_add(1, std::memory_order_relaxed);
  h.batchSeq = batchSeq_.load(std::memory_order_relaxed);
  builder.begin(h);
  const std::size_t n = builder.finalize();
  auto* addr = static_cast<struct sockaddr_in*>(targetAddr_);
  sendto(sock_, buf, n, 0, reinterpret_cast<struct sockaddr*>(addr), sizeof(*addr));
  ESP_LOGW(kTag, "sent maintenance notice to collector");
}

}  // namespace rfsense
