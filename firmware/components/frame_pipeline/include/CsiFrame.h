// One captured CSI observation: protocol metadata + a fixed-capacity raw CSI buffer.
// Sizing constants for the whole pipeline live here (single source).
#pragma once

#include <cstdint>

#include "Protocol.h"

namespace rfsense {

// Upper bound on a single ESP32-S3 CSI buffer (HT-LTF). Frames larger than this are
// truncated and flagged via the drop counter; in practice S3 HT20 CSI is <= 384 bytes.
inline constexpr uint16_t kMaxCsiBytes = 512;

#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
// Disposable classic-ESP32 profile: fit the pipeline in internal RAM.
inline constexpr uint32_t kFramePoolDepth = 24;
inline constexpr uint32_t kBatchQueueDepth = 8;
#else
// Production S3 profile: queues live in PSRAM.
inline constexpr uint32_t kFramePoolDepth = 256;
inline constexpr uint32_t kBatchQueueDepth = 64;
#endif

struct CsiSlot {
  proto::FrameHeader header;
  uint8_t csi[kMaxCsiBytes];
};

}  // namespace rfsense
