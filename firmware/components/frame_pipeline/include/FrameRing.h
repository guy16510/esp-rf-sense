// Pure single-producer / single-consumer ring over a caller-provided CsiSlot pool.
//
// No FreeRTOS, no heap, no logging: this is the host-tested core of FrameQueue. The CSI
// callback is the sole producer; the encode task is the sole consumer. On overflow the
// newest frame is dropped (documented policy) and dropCount() is incremented.
#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>

#include "CsiFrame.h"

namespace rfsense {

class FrameRing {
 public:
  FrameRing(CsiSlot* pool, uint32_t capacity) : pool_(pool), capacity_(capacity) {}

  // Producer side. Copies header + up to kMaxCsiBytes of csi into the next slot and
  // publishes it. Returns false (and increments dropCount) when the ring is full.
  bool tryPush(const proto::FrameHeader& header, const uint8_t* csi, uint16_t csiLen) {
    const uint32_t head = head_.load(std::memory_order_relaxed);
    const uint32_t tail = tail_.load(std::memory_order_acquire);
    if (head - tail >= capacity_) {
      drops_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    CsiSlot& slot = pool_[head % capacity_];
    slot.header = header;
    const uint16_t n = csiLen > kMaxCsiBytes ? kMaxCsiBytes : csiLen;
    slot.header.csiLen = n;
    if (n > 0 && csi != nullptr) {
      std::memcpy(slot.csi, csi, n);
    }
    head_.store(head + 1, std::memory_order_release);
    return true;
  }

  // Consumer side. Returns the oldest unread slot without advancing, or nullptr if empty.
  CsiSlot* peek() {
    const uint32_t tail = tail_.load(std::memory_order_relaxed);
    const uint32_t head = head_.load(std::memory_order_acquire);
    if (tail == head) {
      return nullptr;
    }
    return &pool_[tail % capacity_];
  }

  // Advances past the slot returned by peek(). Call exactly once per consumed slot.
  void pop() {
    const uint32_t tail = tail_.load(std::memory_order_relaxed);
    if (tail != head_.load(std::memory_order_acquire)) {
      tail_.store(tail + 1, std::memory_order_release);
    }
  }

  uint32_t count() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }
  uint32_t capacity() const { return capacity_; }
  uint64_t dropCount() const { return drops_.load(std::memory_order_relaxed); }

 private:
  CsiSlot* pool_;
  uint32_t capacity_;
  std::atomic<uint32_t> head_{0};
  std::atomic<uint32_t> tail_{0};
  std::atomic<uint64_t> drops_{0};
};

}  // namespace rfsense
