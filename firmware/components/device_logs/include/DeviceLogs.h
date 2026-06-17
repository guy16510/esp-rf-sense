#pragma once

#include <cstddef>
#include <cstdint>

#include "freertos/FreeRTOS.h"

namespace rfsense {

struct DeviceLogEntry {
  uint32_t sequence = 0;
  uint32_t uptimeMs = 0;
  char line[192] = {};
};

class DeviceLogs {
 public:
  static DeviceLogs& instance();

  void install();
  void append(const char* line, uint32_t uptimeMs);
  void appendNow(const char* line);
  std::size_t readSince(uint32_t afterSequence, DeviceLogEntry* out, std::size_t capacity) const;
  uint32_t latestSequence() const;
  uint32_t dropped() const;

 private:
  DeviceLogs() = default;

  mutable portMUX_TYPE lock_ = portMUX_INITIALIZER_UNLOCKED;
  bool installed_ = false;
  uint32_t nextSequence_ = 1;
  uint32_t dropped_ = 0;
  DeviceLogEntry entries_[96] = {};
};

}  // namespace rfsense
