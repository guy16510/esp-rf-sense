// Compile-time build metadata and firmware-wide tunables.
//
// Version strings are injected by firmware/main/CMakeLists.txt as preprocessor defines so
// there is exactly one source of truth (firmware/version.txt + git + the partition CSV).
#pragma once

#include <cstdint>

#include "Protocol.h"

namespace rfsense {

#ifndef RF_SENSE_VERSION
#define RF_SENSE_VERSION "0.0.0"
#endif
#ifndef RF_SENSE_GIT_COMMIT
#define RF_SENSE_GIT_COMMIT "unknown"
#endif
#ifndef RF_SENSE_BUILD_TIMESTAMP
#define RF_SENSE_BUILD_TIMESTAMP "1970-01-01T00:00:00Z"
#endif
#ifndef RF_SENSE_PARTITION_TABLE_HASH
#define RF_SENSE_PARTITION_TABLE_HASH "unknown"
#endif

struct BuildInfo {
  const char* version;
  const char* gitCommit;
  const char* buildTimestamp;
  const char* partitionTableHash;
  const char* hardwareTarget;  // e.g. "esp32s3"
  uint8_t protocolVersion;
  const char* apiVersion;  // control API version, e.g. "v1"
};

inline BuildInfo buildInfo() {
  return BuildInfo{
      RF_SENSE_VERSION,
      RF_SENSE_GIT_COMMIT,
      RF_SENSE_BUILD_TIMESTAMP,
      RF_SENSE_PARTITION_TABLE_HASH,
      CONFIG_IDF_TARGET,
      proto::kProtocolVersion,
      "v1",
  };
}

// Hardware/board identity the OTA manifest must match.
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
inline constexpr char kBoardId[] = "esp32-classic-experiment";
#else
inline constexpr char kBoardId[] = "esp32-s3-wroom-1-n4r8";
#endif
inline constexpr uint32_t kFlashSizeBytes = 4u * 1024u * 1024u;

// One OTA application slot size from partitions.csv (0x1f0000). Used as an early sanity
// bound; the authoritative size is read at runtime from the partition table.
inline constexpr uint32_t kOtaSlotSizeBytes = 0x1f0000u;

// Frame-pipeline sizing (kMaxCsiBytes / kFramePoolDepth / kBatchQueueDepth) is defined in
// frame_pipeline/include/CsiFrame.h to keep one source of truth.

// --- Task priorities (higher = more urgent) ---
inline constexpr int kPrioEncode = 6;   // drains the frame pool, builds datagrams
inline constexpr int kPrioNetwork = 5;  // sends datagrams over UDP
inline constexpr int kPrioPing = 4;     // controlled ping generation
inline constexpr int kPrioControl = 4;  // HTTP control API

// --- Defaults applied when NVS holds no value yet ---
inline constexpr uint16_t kDefaultControlPort = 80;
inline constexpr uint16_t kDefaultCollectorPort = 5566;
inline constexpr uint16_t kDefaultPingPps = 25;
inline constexpr uint16_t kDefaultPingPayload = 32;
inline constexpr uint32_t kDefaultPingWarmupMs = 1000;

}  // namespace rfsense
