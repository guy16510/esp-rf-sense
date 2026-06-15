// A finished datagram (header + frame records + CRC) ready for the network task.
#pragma once

#include <cstdint>

#include "Protocol.h"

namespace rfsense {

struct FrameBatch {
  uint16_t len = 0;
  uint8_t data[proto::kMaxDatagramSize] = {0};
};

}  // namespace rfsense
