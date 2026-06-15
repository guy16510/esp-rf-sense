// Protocol serialization, CRC32, and datagram round-trip.
#include <cstring>

#include "Protocol.h"
#include "check.h"

using namespace rfsense;
using namespace rfsense::proto;

int main() {
  // Canonical CRC32 check value for the ASCII string "123456789".
  const char* s = "123456789";
  CHECK(crc32(reinterpret_cast<const uint8_t*>(s), 9) == 0xCBF43926u);

  // Incremental hashing chains to the one-shot result.
  const uint8_t buf[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
  uint32_t chained = crc32Update(crc32Update(0u, buf, 4), buf + 4, 6);
  CHECK(chained == crc32(buf, sizeof(buf)));

  // Build a two-frame datagram and parse it back.
  uint8_t pkt[kMaxDatagramSize];
  DatagramBuilder b(pkt, sizeof(pkt));
  DatagramHeader h;
  h.deviceId = 0xAABBCCDDu;
  h.bootId = 0x11223344u;
  h.packetSeq = 7;
  h.batchSeq = 9;
  h.captureMode = CaptureMode::Controlled;
  b.begin(h);

  const uint8_t csi[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  FrameHeader f;
  f.frameSeq = 1;
  f.timestampUs = 123456789ULL;
  f.pingSeq = 42;
  f.rssi = -50;
  f.noiseFloor = -90;
  f.channel = 6;
  f.linkId = 0x1234;
  f.csiLen = 8;
  CHECK(b.canFit(8));
  CHECK(b.addFrame(f, csi));
  f.frameSeq = 2;
  f.pingSeq = kPingSeqNone;
  CHECK(b.addFrame(f, csi));
  CHECK(b.frameCount() == 2);

  const std::size_t n = b.finalize();
  CHECK(n == kDatagramHeaderSize + 2 * (kFrameFixedSize + 8) + kCrcSize);

  DatagramHeader ph;
  ParseStatus st = parseHeader(pkt, n, ph);
  CHECK(st.ok);
  CHECK(ph.deviceId == 0xAABBCCDDu);
  CHECK(ph.bootId == 0x11223344u);
  CHECK(ph.packetSeq == 7);
  CHECK(ph.frameCount == 2);
  CHECK(ph.captureMode == CaptureMode::Controlled);
  CHECK(verifyCrc(pkt, n));

  std::size_t off = kDatagramHeaderSize;
  FrameHeader pf;
  const uint8_t* csiPtr = nullptr;
  CHECK(parseFrame(pkt, n, off, pf, &csiPtr));
  CHECK(pf.frameSeq == 1);
  CHECK(pf.pingSeq == 42);
  CHECK(pf.rssi == -50);
  CHECK(pf.noiseFloor == -90);
  CHECK(pf.linkId == 0x1234);
  CHECK(pf.csiLen == 8);
  CHECK(csiPtr != nullptr && std::memcmp(csiPtr, csi, 8) == 0);

  CHECK(parseFrame(pkt, n, off, pf, &csiPtr));
  CHECK(pf.frameSeq == 2);
  CHECK(pf.pingSeq == kPingSeqNone);
  CHECK(off == n - kCrcSize);

  // Corrupting any body byte must break the CRC.
  pkt[40] ^= 0xFF;
  CHECK(!verifyCrc(pkt, n));

  // canFit refuses a frame that would exceed the MTU budget.
  DatagramBuilder b2(pkt, sizeof(pkt));
  b2.begin(h);
  CHECK(!b2.canFit(kMaxDatagramSize));

  return SUMMARY();
}
