#include "FrameQueue.h"

#include <new>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "frame_pipeline";
}

FrameQueue& FrameQueue::instance() {
  static FrameQueue q;
  return q;
}

bool FrameQueue::init(uint32_t depth) {
  if (initialized_) {
    return true;
  }
  // One-time pool allocation (never allocated per-frame).
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
  constexpr uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  constexpr char memoryName[] = "internal RAM";
#else
  constexpr uint32_t caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  constexpr char memoryName[] = "PSRAM";
#endif
  pool_ = static_cast<CsiSlot*>(heap_caps_malloc(sizeof(CsiSlot) * depth, caps));
  if (pool_ == nullptr) {
    ESP_LOGE(kTag, "failed to allocate %u-slot CSI pool in %s", static_cast<unsigned>(depth),
             memoryName);
    return false;
  }
  ring_ = new (std::nothrow) FrameRing(pool_, depth);
  if (ring_ == nullptr) {
    heap_caps_free(pool_);
    pool_ = nullptr;
    return false;
  }
  itemsSem_ = xSemaphoreCreateCounting(depth, 0);
  if (itemsSem_ == nullptr) {
    delete ring_;
    ring_ = nullptr;
    heap_caps_free(pool_);
    pool_ = nullptr;
    return false;
  }
  initialized_ = true;
  ESP_LOGI(kTag, "frame pool ready: %u slots x %u bytes (%s)", static_cast<unsigned>(depth),
           static_cast<unsigned>(sizeof(CsiSlot)), memoryName);
  return true;
}

bool FrameQueue::pushFromCapture(const proto::FrameHeader& header, const uint8_t* csi,
                                 uint16_t csiLen) {
  if (!initialized_) {
    return false;
  }
  if (!ring_->tryPush(header, csi, csiLen)) {
    return false;  // full -> dropped (FrameRing counts it)
  }
  // Non-blocking signal; the count can never exceed the ring capacity so this won't fail.
  xSemaphoreGive(static_cast<SemaphoreHandle_t>(itemsSem_));
  return true;
}

CsiSlot* FrameQueue::popReady(uint32_t timeoutMs) {
  if (!initialized_) {
    return nullptr;
  }
  const TickType_t ticks =
      (timeoutMs == portMAX_DELAY) ? portMAX_DELAY : pdMS_TO_TICKS(timeoutMs);
  if (xSemaphoreTake(static_cast<SemaphoreHandle_t>(itemsSem_), ticks) != pdTRUE) {
    return nullptr;
  }
  return ring_->peek();
}

void FrameQueue::release(CsiSlot* slot) {
  if (!initialized_ || slot == nullptr) {
    return;
  }
  ring_->pop();
}

uint32_t FrameQueue::queued() const { return ring_ ? ring_->count() : 0; }
uint64_t FrameQueue::drops() const { return ring_ ? ring_->dropCount() : 0; }

void FrameQueue::drain() {
  if (!initialized_) {
    return;
  }
  // Consumer-side drain: take whatever is signaled and discard it.
  while (xSemaphoreTake(static_cast<SemaphoreHandle_t>(itemsSem_), 0) == pdTRUE) {
    ring_->pop();
  }
  ESP_LOGW(kTag, "frame queue drained for maintenance");
}

}  // namespace rfsense
