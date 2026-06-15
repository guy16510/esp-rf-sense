// Central, lock-free-ish telemetry aggregator. Every subsystem reports counters here; the
// control API renders snapshots as JSON. No failure is hidden behind a single "offline" flag.
#pragma once

#include <atomic>
#include <cstdint>

namespace rfsense {

// Persistent boot/OTA stats owned by ota_manager's BootGuard, mirrored here for snapshots.
struct PersistentStats {
  uint32_t bootCount = 0;
  uint32_t consecutiveFailedBoots = 0;
  uint32_t rollbackCount = 0;
  uint32_t otaAttempts = 0;
  uint32_t otaSuccesses = 0;
  uint32_t otaFailures = 0;
};

struct HealthSnapshot {
  uint32_t uptimeSeconds;
  const char* bootReason;   // esp_reset_reason() text
  const char* resetReason;  // alias kept for the documented field name
  uint32_t bootCount;
  uint32_t consecutiveFailedBoots;

  uint32_t freeHeap;
  uint32_t minFreeHeap;
  uint32_t psramFree;
  uint32_t psramTotal;

  uint64_t csiFramesCaptured;
  uint32_t csiFramesQueued;
  uint64_t csiQueueDrops;
  uint64_t networkBatchesSent;
  uint64_t networkSendFailures;
  uint64_t networkQueueDrops;  // batches dropped locally (encode->network backpressure)
  uint64_t networkBytesSent;
  uint32_t collectorPacketLossPpm;  // collector-reported; 0/unknown on the device

  uint64_t pingRequests;
  uint64_t pingReplies;
  uint32_t wifiReconnectCount;
  int8_t currentRssi;

  uint32_t otaAttempts;
  uint32_t otaSuccesses;
  uint32_t otaFailures;
  uint32_t rollbackCount;
  uint32_t watchdogEvents;

  // Task stack headroom (min free words observed), per tracked task. -1 if not tracked.
  int32_t stackEncodeWords;
  int32_t stackNetworkWords;
  int32_t stackPingWords;
};

class DeviceHealth {
 public:
  static DeviceHealth& instance();

  // --- counters (called from many tasks; relaxed atomics) ---
  void incCsiCaptured(uint32_t n = 1) { csiFramesCaptured_ += n; }
  void setCsiQueued(uint32_t n) { csiFramesQueued_.store(n, std::memory_order_relaxed); }
  void incCsiQueueDrops(uint32_t n = 1) { csiQueueDrops_ += n; }
  void incNetworkBatches(uint32_t n = 1) { networkBatchesSent_ += n; }
  void incNetworkSendFailures(uint32_t n = 1) { networkSendFailures_ += n; }
  void incNetworkQueueDrops(uint32_t n = 1) { networkQueueDrops_ += n; }
  void addNetworkBytes(uint32_t n) { networkBytesSent_ += n; }
  void incPingRequests(uint32_t n = 1) { pingRequests_ += n; }
  void incPingReplies(uint32_t n = 1) { pingReplies_ += n; }
  void incWifiReconnect() { wifiReconnects_ += 1; }
  void setRssi(int8_t rssi) { currentRssi_.store(rssi, std::memory_order_relaxed); }
  void incWatchdogEvents() { watchdogEvents_ += 1; }
  void setCollectorPacketLossPpm(uint32_t ppm) {
    collectorLossPpm_.store(ppm, std::memory_order_relaxed);
  }

  // Task stack headroom in words (StackType_t units); -1 means untracked.
  void recordStackEncode(int32_t words) { stackEncode_.store(words, std::memory_order_relaxed); }
  void recordStackNetwork(int32_t words) { stackNetwork_.store(words, std::memory_order_relaxed); }
  void recordStackPing(int32_t words) { stackPing_.store(words, std::memory_order_relaxed); }

  // Persistent stats mirror (set by ota_manager BootGuard).
  void setPersistentStats(const PersistentStats& s);

  HealthSnapshot snapshot() const;

 private:
  DeviceHealth() = default;

  std::atomic<uint64_t> csiFramesCaptured_{0};
  std::atomic<uint32_t> csiFramesQueued_{0};
  std::atomic<uint64_t> csiQueueDrops_{0};
  std::atomic<uint64_t> networkBatchesSent_{0};
  std::atomic<uint64_t> networkSendFailures_{0};
  std::atomic<uint64_t> networkQueueDrops_{0};
  std::atomic<uint64_t> networkBytesSent_{0};
  std::atomic<uint64_t> pingRequests_{0};
  std::atomic<uint64_t> pingReplies_{0};
  std::atomic<uint32_t> wifiReconnects_{0};
  std::atomic<int8_t> currentRssi_{0};
  std::atomic<uint32_t> watchdogEvents_{0};
  std::atomic<uint32_t> collectorLossPpm_{0};
  std::atomic<int32_t> stackEncode_{-1};
  std::atomic<int32_t> stackNetwork_{-1};
  std::atomic<int32_t> stackPing_{-1};

  // Mirrored persistent stats (plain; updated infrequently from one task).
  PersistentStats persistent_{};
};

}  // namespace rfsense
