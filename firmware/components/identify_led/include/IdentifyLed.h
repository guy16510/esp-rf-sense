#pragma once

#include <cstdint>

#include "esp_err.h"

namespace rfsense {

struct IdentifyLedStatus {
  bool supported = false;
  const char* ledType = "none";
  int gpio = -1;
  uint32_t durationMs = 0;
  const char* message = "identify LED is not configured";
};

class IdentifyLed {
 public:
  static IdentifyLed& instance();

  IdentifyLedStatus status(uint32_t durationMs = 0) const;
  esp_err_t identify(uint32_t durationMs);

 private:
  IdentifyLed() = default;
};

}  // namespace rfsense
