// Pure serialization + validation for DeviceConfig. No ESP-IDF dependency: this is the
// host-tested core behind ConfigStore. The on-flash blob is versioned and CRC-protected.
#pragma once

#include <cstddef>
#include <cstdint>

#include "DeviceConfig.h"

namespace rfsense {

class ConfigCodec {
 public:
  static constexpr uint32_t kMagic = 0x52534346u;  // "RSCF"
  static constexpr uint16_t kVersion = 1;
  // Header(8) + struct payload + crc(4). Generous fixed bound for the NVS blob.
  static constexpr std::size_t kMaxBlobSize = 768;

  // Serializes cfg into out[0..outCap). Returns bytes written, or 0 on insufficient space.
  static std::size_t encode(const DeviceConfig& cfg, uint8_t* out, std::size_t outCap);

  // Parses a blob into cfg. Returns false on magic/version/length/CRC error.
  static bool decode(const uint8_t* in, std::size_t len, DeviceConfig& cfg);

  // Semantic validation independent of encoding. errorOut (optional) names the first problem.
  // Note: passing this does NOT mean provisioned — only that fields are individually sane.
  static bool validate(const DeviceConfig& cfg, const char** errorOut);

  // True when cfg has the minimum fields required to operate in station mode.
  static bool isComplete(const DeviceConfig& cfg);
};

}  // namespace rfsense
