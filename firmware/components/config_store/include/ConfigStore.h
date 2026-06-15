// NVS-backed persistence for DeviceConfig. Thread-safe. Secrets are never logged.
#pragma once

#include "DeviceConfig.h"
#include "esp_err.h"

namespace rfsense {

class ConfigStore {
 public:
  static ConfigStore& instance();

  // Opens the NVS namespace and loads the stored config (or defaults if none). Must be
  // called once after nvs_flash_init().
  esp_err_t init();

  // Returns a copy of the current config (taken under lock).
  DeviceConfig get() const;

  // Validates, encodes, and persists cfg. Returns ESP_ERR_INVALID_ARG on validation failure.
  esp_err_t save(const DeviceConfig& cfg);

  // Wipes provisioning so the next boot enters SoftAP setup. Keeps NVS namespace intact.
  esp_err_t clearProvisioning();

  bool isProvisioned() const;

 private:
  ConfigStore() = default;
  esp_err_t load();

  DeviceConfig cfg_{};
  void* mutex_ = nullptr;  // SemaphoreHandle_t
  bool initialized_ = false;
};

}  // namespace rfsense
