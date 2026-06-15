// FreeRTOS wrapper around FrameRing: blocking consumer pop + a PSRAM-backed slot pool.
// The capture-context producer never blocks; the encode task waits on a counting semaphore.
#pragma once

#include <cstdint>

#include "CsiFrame.h"
#include "FrameRing.h"

namespace rfsense {

class FrameQueue {
 public:
  static FrameQueue& instance();

  // Allocates the slot pool (PSRAM) and the consumer semaphore. Call once at startup.
  bool init(uint32_t depth = kFramePoolDepth);

  // Producer (CSI callback context). Non-blocking. Returns false on drop.
  bool pushFromCapture(const proto::FrameHeader& header, const uint8_t* csi, uint16_t csiLen);

  // Consumer (encode task). Waits up to timeoutMs for a slot. Returns nullptr on timeout.
  // The returned pointer is valid until release() is called.
  CsiSlot* popReady(uint32_t timeoutMs);

  // Returns the slot acquired by popReady() to the ring.
  void release(CsiSlot* slot);

  uint32_t queued() const;
  uint64_t drops() const;

  // Discards all queued frames (used when entering OTA maintenance). Consumer-side only.
  void drain();

 private:
  FrameQueue() = default;

  CsiSlot* pool_ = nullptr;
  FrameRing* ring_ = nullptr;
  void* itemsSem_ = nullptr;  // SemaphoreHandle_t (counting)
  bool initialized_ = false;
};

}  // namespace rfsense
