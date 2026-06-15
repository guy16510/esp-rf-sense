#include "Protocol.h"

#include <cstring>

namespace rfsense::proto {
namespace {

inline void putU16(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

inline void putU32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
}

inline void putU64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; ++i) {
    p[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xFF);
  }
}

inline uint16_t getU16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

inline uint32_t getU32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint64_t getU64(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; ++i) {
    v |= static_cast<uint64_t>(p[i]) << (8 * i);
  }
  return v;
}

}  // namespace

uint32_t crc32Update(uint32_t crc, const uint8_t* data, std::size_t len) {
  crc = ~crc;
  for (std::size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int b = 0; b < 8; ++b) {
      const uint32_t mask = -(crc & 1u);
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~crc;
}

uint32_t crc32(const uint8_t* data, std::size_t len) { return crc32Update(0u, data, len); }

DatagramBuilder::DatagramBuilder(uint8_t* buffer, std::size_t capacity)
    : buf_(buffer), cap_(capacity) {}

void DatagramBuilder::begin(const DatagramHeader& header) {
  frameCount_ = 0;
  offset_ = 0;
  begun_ = false;
  if (cap_ < kDatagramHeaderSize + kCrcSize) {
    return;  // buffer too small to ever hold a valid datagram
  }
  buf_[0] = kMagic0;
  buf_[1] = kMagic1;
  buf_[2] = kMagic2;
  buf_[3] = kMagic3;
  buf_[4] = header.protocolVersion;
  buf_[5] = header.flags;
  buf_[6] = static_cast<uint8_t>(header.captureMode);
  buf_[7] = 0;  // reserved0
  putU32(buf_ + 8, header.deviceId);
  putU32(buf_ + 12, header.bootId);
  putU32(buf_ + 16, header.packetSeq);
  putU32(buf_ + 20, header.batchSeq);
  putU16(buf_ + 24, 0);  // frameCount placeholder
  putU16(buf_ + 26, 0);  // payloadLen placeholder
  putU32(buf_ + 28, 0);  // reserved1
  offset_ = kDatagramHeaderSize;
  begun_ = true;
}

bool DatagramBuilder::canFit(uint16_t csiLen) const {
  if (!begun_) {
    return false;
  }
  const std::size_t need = kFrameFixedSize + csiLen;
  const std::size_t projected = offset_ + need + kCrcSize;
  return projected <= cap_ && projected <= kMaxDatagramSize;
}

bool DatagramBuilder::addFrame(const FrameHeader& frame, const uint8_t* csi) {
  if (!canFit(frame.csiLen)) {
    return false;
  }
  uint8_t* p = buf_ + offset_;
  putU32(p + 0, frame.frameSeq);
  putU64(p + 4, frame.timestampUs);
  putU32(p + 12, frame.pingSeq);
  p[16] = static_cast<uint8_t>(frame.rssi);
  p[17] = static_cast<uint8_t>(frame.noiseFloor);
  p[18] = frame.channel;
  p[19] = frame.secondaryChannel;
  p[20] = frame.bandwidth;
  p[21] = frame.phyMode;
  p[22] = frame.rate;
  p[23] = frame.firstWordInvalid;
  putU16(p + 24, frame.linkId);
  putU16(p + 26, frame.csiLen);
  if (frame.csiLen > 0 && csi != nullptr) {
    std::memcpy(p + kFrameFixedSize, csi, frame.csiLen);
  }
  offset_ += kFrameFixedSize + frame.csiLen;
  ++frameCount_;
  return true;
}

std::size_t DatagramBuilder::finalize() {
  if (!begun_) {
    return 0;
  }
  const uint16_t payloadLen = static_cast<uint16_t>(offset_ - kDatagramHeaderSize);
  putU16(buf_ + 24, frameCount_);
  putU16(buf_ + 26, payloadLen);
  const uint32_t crc = crc32(buf_, offset_);
  putU32(buf_ + offset_, crc);
  offset_ += kCrcSize;
  return offset_;
}

ParseStatus parseHeader(const uint8_t* buf, std::size_t len, DatagramHeader& out) {
  if (len < kDatagramHeaderSize + kCrcSize) {
    return {false, "datagram too short"};
  }
  if (buf[0] != kMagic0 || buf[1] != kMagic1 || buf[2] != kMagic2 || buf[3] != kMagic3) {
    return {false, "bad magic"};
  }
  out.protocolVersion = buf[4];
  if (out.protocolVersion != kProtocolVersion) {
    return {false, "unsupported protocol version"};
  }
  out.flags = buf[5];
  out.captureMode = static_cast<CaptureMode>(buf[6]);
  out.deviceId = getU32(buf + 8);
  out.bootId = getU32(buf + 12);
  out.packetSeq = getU32(buf + 16);
  out.batchSeq = getU32(buf + 20);
  out.frameCount = getU16(buf + 24);
  out.payloadLen = getU16(buf + 26);
  if (kDatagramHeaderSize + out.payloadLen + kCrcSize != len) {
    return {false, "payloadLen mismatch"};
  }
  return {true, nullptr};
}

bool verifyCrc(const uint8_t* buf, std::size_t len) {
  if (len < kDatagramHeaderSize + kCrcSize) {
    return false;
  }
  const std::size_t bodyLen = len - kCrcSize;
  const uint32_t expected = crc32(buf, bodyLen);
  const uint32_t actual = getU32(buf + bodyLen);
  return expected == actual;
}

bool parseFrame(const uint8_t* buf, std::size_t len, std::size_t& byteOffset, FrameHeader& out,
                const uint8_t** csiOut) {
  if (byteOffset + kFrameFixedSize > len) {
    return false;
  }
  const uint8_t* p = buf + byteOffset;
  out.frameSeq = getU32(p + 0);
  out.timestampUs = getU64(p + 4);
  out.pingSeq = getU32(p + 12);
  out.rssi = static_cast<int8_t>(p[16]);
  out.noiseFloor = static_cast<int8_t>(p[17]);
  out.channel = p[18];
  out.secondaryChannel = p[19];
  out.bandwidth = p[20];
  out.phyMode = p[21];
  out.rate = p[22];
  out.firstWordInvalid = p[23];
  out.linkId = getU16(p + 24);
  out.csiLen = getU16(p + 26);
  if (byteOffset + kFrameFixedSize + out.csiLen > len) {
    return false;
  }
  if (csiOut != nullptr) {
    *csiOut = p + kFrameFixedSize;
  }
  byteOffset += kFrameFixedSize + out.csiLen;
  return true;
}

}  // namespace rfsense::proto
