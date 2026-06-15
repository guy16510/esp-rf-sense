// Binary CSI streaming protocol v1. See docs/csi-protocol.md.
//
// This header is intentionally free of any ESP-IDF dependency so it can be compiled
// unchanged on the host for unit tests (firmware/components/protocol/test) and inside the
// firmware. Serialization is byte-by-byte little-endian; never rely on struct layout.
#pragma once

#include <cstddef>
#include <cstdint>

namespace rfsense::proto {

inline constexpr uint8_t kMagic0 = 'R';
inline constexpr uint8_t kMagic1 = 'F';
inline constexpr uint8_t kMagic2 = 'C';
inline constexpr uint8_t kMagic3 = 'S';

inline constexpr uint8_t kProtocolVersion = 1;

inline constexpr std::size_t kDatagramHeaderSize = 32;
inline constexpr std::size_t kFrameFixedSize = 28;
inline constexpr std::size_t kCrcSize = 4;
inline constexpr std::size_t kMaxDatagramSize = 1400;

inline constexpr uint32_t kPingSeqNone = 0xFFFFFFFFu;

inline constexpr uint8_t kFlagMaintenance = 0x01;

enum class CaptureMode : uint8_t {
  Controlled = 0,
  Normal = 1,
  Passive = 2,
};

struct DatagramHeader {
  uint8_t protocolVersion = kProtocolVersion;
  uint8_t flags = 0;
  CaptureMode captureMode = CaptureMode::Controlled;
  uint32_t deviceId = 0;
  uint32_t bootId = 0;
  uint32_t packetSeq = 0;
  uint32_t batchSeq = 0;
  uint16_t frameCount = 0;
  uint16_t payloadLen = 0;
};

struct FrameHeader {
  uint32_t frameSeq = 0;
  uint64_t timestampUs = 0;
  uint32_t pingSeq = kPingSeqNone;
  int8_t rssi = 0;
  int8_t noiseFloor = 0;
  uint8_t channel = 0;
  uint8_t secondaryChannel = 0;
  uint8_t bandwidth = 0;
  uint8_t phyMode = 0;
  uint8_t rate = 0;
  uint8_t firstWordInvalid = 0;
  uint16_t linkId = 0;
  uint16_t csiLen = 0;
};

// IEEE 802.3 CRC32 (reflected, poly 0xEDB88320).
uint32_t crc32(const uint8_t* data, std::size_t len);
uint32_t crc32Update(uint32_t crc, const uint8_t* data, std::size_t len);

// Builds one datagram into a caller-provided fixed buffer. No heap allocation.
// Usage: begin(header) -> addFrame()* -> finalize(). canFit() guards MTU.
class DatagramBuilder {
 public:
  DatagramBuilder(uint8_t* buffer, std::size_t capacity);

  // Writes the 32-byte header with placeholder frameCount/payloadLen. Resets state.
  void begin(const DatagramHeader& header);

  // True if a frame carrying csiLen CSI bytes still fits under kMaxDatagramSize and capacity.
  bool canFit(uint16_t csiLen) const;

  // Appends one frame record. Returns false (and writes nothing) if it would overflow.
  bool addFrame(const FrameHeader& frame, const uint8_t* csi);

  // Patches frameCount/payloadLen in the header and appends the CRC32. Returns total bytes.
  std::size_t finalize();

  uint16_t frameCount() const { return frameCount_; }
  std::size_t size() const { return offset_; }

 private:
  uint8_t* buf_;
  std::size_t cap_;
  std::size_t offset_ = 0;   // current write cursor (before crc)
  uint16_t frameCount_ = 0;
  bool begun_ = false;
};

// Read side (used by host tests; the collector implements the same logic in TypeScript).
struct ParseStatus {
  bool ok = false;
  const char* error = nullptr;
};

ParseStatus parseHeader(const uint8_t* buf, std::size_t len, DatagramHeader& out);
bool verifyCrc(const uint8_t* buf, std::size_t len);

// Parses the i-th frame header starting at byteOffset; advances byteOffset past the CSI bytes.
// csiOut points into buf (no copy). Returns false on bounds error.
bool parseFrame(const uint8_t* buf, std::size_t len, std::size_t& byteOffset, FrameHeader& out,
                const uint8_t** csiOut);

}  // namespace rfsense::proto
