// SPSC ring behavior: ordering, fullness, drop-newest-on-overflow, and CSI truncation.
#include <cstring>

#include "FrameRing.h"
#include "check.h"

using namespace rfsense;

int main() {
  constexpr uint32_t kCap = 4;
  CsiSlot pool[kCap];
  FrameRing ring(pool, kCap);

  CHECK(ring.capacity() == kCap);
  CHECK(ring.count() == 0);
  CHECK(ring.peek() == nullptr);

  proto::FrameHeader h{};
  const uint8_t csi[4] = {9, 8, 7, 6};
  for (uint32_t i = 0; i < kCap; ++i) {
    h.frameSeq = i;
    CHECK(ring.tryPush(h, csi, 4));
  }
  CHECK(ring.count() == kCap);

  // Overflow drops the newest write (oldest data is preserved for the consumer).
  h.frameSeq = 99;
  CHECK(!ring.tryPush(h, csi, 4));
  CHECK(ring.dropCount() == 1);

  // FIFO order out.
  CsiSlot* s = ring.peek();
  CHECK(s != nullptr);
  CHECK(s->header.frameSeq == 0);
  CHECK(s->header.csiLen == 4);
  CHECK(std::memcmp(s->csi, csi, 4) == 0);
  ring.pop();
  CHECK(ring.count() == kCap - 1);

  // Space frees up after a pop.
  h.frameSeq = 100;
  CHECK(ring.tryPush(h, csi, 4));
  CHECK(ring.count() == kCap);

  s = ring.peek();
  CHECK(s->header.frameSeq == 1);  // still FIFO

  // Oversized CSI is truncated to kMaxCsiBytes and flagged via csiLen.
  CsiSlot pool2[2];
  FrameRing ring2(pool2, 2);
  proto::FrameHeader big{};
  CHECK(ring2.tryPush(big, csi, 5000));
  CHECK(ring2.peek()->header.csiLen == kMaxCsiBytes);

  return SUMMARY();
}
