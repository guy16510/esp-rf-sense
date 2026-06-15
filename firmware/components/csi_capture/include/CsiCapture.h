// Registers the Wi-Fi CSI receive callback and feeds raw observations into FrameQueue.
//
// The callback runs in a time-sensitive Wi-Fi context. It does the minimum: read metadata,
// copy the raw CSI bytes into a bounded pool slot, tag a per-sender link id, and enqueue.
// No heap, no logging, no DSP, no JSON, no blocking.
#pragma once

#include <atomic>
#include <functional>

#include "Protocol.h"
#include "esp_err.h"
#include "esp_wifi_types_generic.h"

namespace rfsense {

class CsiCapture {
 public:
  static CsiCapture& instance();

  void configureIds(uint32_t deviceId, uint32_t bootId);
  void setCaptureMode(proto::CaptureMode mode);
  proto::CaptureMode captureMode() const { return mode_.load(std::memory_order_relaxed); }

  // Optional best-effort ping correlation: returns the last ping sequence sent.
  void setPingSeqSource(std::function<uint32_t()> source) { pingSeqSource_ = std::move(source); }

  // Enables/disables the CSI receiver. Safe to call repeatedly.
  esp_err_t start();
  esp_err_t stop();
  bool isActive() const { return active_.load(std::memory_order_relaxed); }

  // Link id for a 6-byte BSSID/MAC: low 16 bits of its CRC32. Never stores the raw MAC.
  static uint16_t linkIdForMac(const uint8_t mac[6]);

 private:
  CsiCapture() = default;
  static void rxTrampoline(void* ctx, wifi_csi_info_t* info);
  void onCsi(wifi_csi_info_t* info);

  std::atomic<bool> active_{false};
  std::atomic<proto::CaptureMode> mode_{proto::CaptureMode::Controlled};
  std::atomic<uint32_t> frameSeq_{0};
  uint32_t deviceId_ = 0;
  uint32_t bootId_ = 0;
  std::function<uint32_t()> pingSeqSource_;
};

}  // namespace rfsense
