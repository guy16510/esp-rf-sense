// Drains FrameQueue, builds MTU-safe datagrams (encode task), and sends them to the
// collector over UDP (network task). Bounded batch ring with a drop-oldest policy. Never
// blocks CSI capture; keeps sensing even when the collector is offline.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>

#include "Protocol.h"

namespace rfsense {

class NetworkStreamer {
 public:
  static NetworkStreamer& instance();

  void configure(uint32_t deviceId, uint32_t bootId);
  void setTarget(const std::string& host, uint16_t port);
  void setCaptureMode(proto::CaptureMode mode) { mode_.store(mode, std::memory_order_relaxed); }

  // Starts the UDP socket plus the encode and network tasks.
  bool start();
  // Stops both tasks and closes the socket. Pending batches are discarded.
  void stop();
  bool isRunning() const { return running_.load(std::memory_order_relaxed); }

  // Emits one zero-frame datagram with the maintenance flag set so the collector knows the
  // device is pausing CSI (e.g. for OTA). Best-effort; never blocks.
  void sendMaintenanceNotice();

 private:
  NetworkStreamer() = default;
  static void encodeTaskTramp(void* arg);
  static void networkTaskTramp(void* arg);
  void encodeTask();
  void networkTask();
  bool resolveTarget();

  uint32_t deviceId_ = 0;
  uint32_t bootId_ = 0;
  std::string host_;
  uint16_t port_ = 0;
  std::atomic<proto::CaptureMode> mode_{proto::CaptureMode::Controlled};
  std::atomic<bool> running_{false};
  std::atomic<uint32_t> packetSeq_{0};
  std::atomic<uint32_t> batchSeq_{0};

  int sock_ = -1;
  void* targetAddr_ = nullptr;  // struct sockaddr_in*
  bool targetResolved_ = false;

  void* batchRing_ = nullptr;     // internal BatchRing*
  void* encodeTaskHandle_ = nullptr;
  void* networkTaskHandle_ = nullptr;
};

}  // namespace rfsense
