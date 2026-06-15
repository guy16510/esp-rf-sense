#include "DeviceHealth.h"

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"

namespace rfsense {
namespace {
const char* resetReasonText(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "other_wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}
}  // namespace

DeviceHealth& DeviceHealth::instance() {
  static DeviceHealth h;
  return h;
}

void DeviceHealth::setPersistentStats(const PersistentStats& s) { persistent_ = s; }

HealthSnapshot DeviceHealth::snapshot() const {
  HealthSnapshot s{};
  s.uptimeSeconds = static_cast<uint32_t>(esp_timer_get_time() / 1000000LL);
  const char* reason = resetReasonText(esp_reset_reason());
  s.bootReason = reason;
  s.resetReason = reason;
  s.bootCount = persistent_.bootCount;
  s.consecutiveFailedBoots = persistent_.consecutiveFailedBoots;

  s.freeHeap = static_cast<uint32_t>(esp_get_free_heap_size());
  s.minFreeHeap = static_cast<uint32_t>(esp_get_minimum_free_heap_size());
  s.psramFree = static_cast<uint32_t>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  s.psramTotal = static_cast<uint32_t>(heap_caps_get_total_size(MALLOC_CAP_SPIRAM));

  s.csiFramesCaptured = csiFramesCaptured_.load(std::memory_order_relaxed);
  s.csiFramesQueued = csiFramesQueued_.load(std::memory_order_relaxed);
  s.csiQueueDrops = csiQueueDrops_.load(std::memory_order_relaxed);
  s.networkBatchesSent = networkBatchesSent_.load(std::memory_order_relaxed);
  s.networkSendFailures = networkSendFailures_.load(std::memory_order_relaxed);
  s.networkQueueDrops = networkQueueDrops_.load(std::memory_order_relaxed);
  s.networkBytesSent = networkBytesSent_.load(std::memory_order_relaxed);
  s.collectorPacketLossPpm = collectorLossPpm_.load(std::memory_order_relaxed);

  s.pingRequests = pingRequests_.load(std::memory_order_relaxed);
  s.pingReplies = pingReplies_.load(std::memory_order_relaxed);
  s.wifiReconnectCount = wifiReconnects_.load(std::memory_order_relaxed);
  s.currentRssi = currentRssi_.load(std::memory_order_relaxed);
  s.watchdogEvents = watchdogEvents_.load(std::memory_order_relaxed);

  s.otaAttempts = persistent_.otaAttempts;
  s.otaSuccesses = persistent_.otaSuccesses;
  s.otaFailures = persistent_.otaFailures;
  s.rollbackCount = persistent_.rollbackCount;

  s.stackEncodeWords = stackEncode_.load(std::memory_order_relaxed);
  s.stackNetworkWords = stackNetwork_.load(std::memory_order_relaxed);
  s.stackPingWords = stackPing_.load(std::memory_order_relaxed);
  return s;
}

}  // namespace rfsense
