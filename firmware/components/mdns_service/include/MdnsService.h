// Advertises the device on the LAN via mDNS so the collector/CLI can discover it without a
// hard-coded IP. Hostname is rf-sense-<id4>.local; an _http._tcp service on port 80 carries
// TXT metadata (firmware version, API version, device id, target, capture + OTA state).
// Direct-IP access always remains available; mDNS is a convenience, never the only path.
#pragma once

#include <string>

#include "esp_err.h"

namespace rfsense {

class MdnsService {
 public:
  static MdnsService& instance();

  // hostname e.g. "rf-sense-a1b2" (without the .local suffix). instanceName is the friendly
  // service label shown by browsers. Adds the control-API HTTP service with static TXT records.
  esp_err_t start(const std::string& hostname, const std::string& instanceName,
                  const std::string& version, uint32_t deviceId, const std::string& target);

  // Refreshes the dynamic TXT records as the device changes state.
  void updateState(bool capturing, const std::string& otaState);

  esp_err_t stop();

 private:
  MdnsService() = default;
  bool started_ = false;
};

}  // namespace rfsense
