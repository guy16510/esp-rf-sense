// Headless Wi-Fi provisioning. On an unprovisioned boot the device brings up a WPA2 SoftAP
// and serves a single minimal HTML form (no JavaScript, no mobile app) at http://192.168.4.1.
// Submitting the form writes DeviceConfig to NVS and reboots into station mode.
#pragma once

#include <string>

#include "esp_err.h"

namespace rfsense {

class Provisioning {
 public:
  static Provisioning& instance();

  // Starts the SoftAP (via WifiManager) and the setup HTTP server. Returns immediately; the
  // device reboots itself once the form is submitted and the config validates.
  esp_err_t start(const std::string& apSsid, const std::string& apPassword);
  esp_err_t stop();

 private:
  Provisioning() = default;
  void* server_ = nullptr;  // httpd_handle_t
};

}  // namespace rfsense
