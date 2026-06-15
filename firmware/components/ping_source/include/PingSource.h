// Controlled ICMP ping generator. In controlled capture mode it pings the router at a fixed
// rate so the router emits a steady, well-timed stream of responses to harvest CSI from.
#pragma once

#include <atomic>
#include <string>

#include "esp_err.h"

namespace rfsense {

struct PingConfig {
  std::string targetIp;       // router/gateway IPv4
  uint16_t packetsPerSecond;  // 1..200
  uint16_t payloadBytes;      // ICMP data size
  uint16_t timeoutMs;         // per-request timeout
  uint32_t warmupMs;          // ignore CSI before this elapses (collector-side hint)
};

class PingSource {
 public:
  static PingSource& instance();

  esp_err_t start(const PingConfig& cfg);
  esp_err_t stop();
  bool isActive() const { return active_.load(std::memory_order_relaxed); }

  // Last ICMP sequence number observed (best-effort CSI correlation).
  uint32_t lastSeq() const { return lastSeq_.load(std::memory_order_relaxed); }

 private:
  PingSource() = default;
  static void onSuccess(void* hdl, void* args);
  static void onTimeout(void* hdl, void* args);
  static void onEnd(void* hdl, void* args);

  void* session_ = nullptr;  // esp_ping_handle_t
  std::atomic<bool> active_{false};
  std::atomic<uint32_t> lastSeq_{0};
};

}  // namespace rfsense
