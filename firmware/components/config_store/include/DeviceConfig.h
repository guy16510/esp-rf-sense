// Provisioned + runtime device configuration. Pure (no ESP-IDF) so it can be unit-tested.
#pragma once

#include <cstdint>

namespace rfsense {

// Fixed-capacity strings keep the whole struct trivially serializable and heap-free.
struct DeviceConfig {
  // Wi-Fi station credentials.
  char wifiSsid[33] = {0};
  char wifiPassword[64] = {0};  // SECRET: never logged, never returned by the API verbatim.

  // OTA.
  char otaManifestUrl[192] = {0};  // must be https:// unless built with the dev flag
  char otaChannel[16] = "stable";

  // Collector (CSI sink).
  char collectorHost[64] = {0};
  uint16_t collectorPort = 5566;

  // Device administration.
  char adminToken[49] = {0};  // SECRET: required for mutating API + OTA.
  char deviceName[32] = {0};

  // Capture defaults.
  uint8_t captureMode = 0;  // 0 controlled, 1 normal, 2 passive
  uint16_t pingPps = 25;
  uint16_t pingPayloadBytes = 32;
  uint16_t pingTimeoutMs = 500;
  uint32_t pingWarmupMs = 1000;

  // Scheduled OTA. Disabled by default; auto-apply NEVER on by default.
  bool otaScheduledEnabled = false;
  uint32_t otaScheduledIntervalS = 86400;
  bool otaAutoApply = false;

  // Set true once provisioning succeeds. When false the device boots into SoftAP setup.
  bool provisioned = false;
};

}  // namespace rfsense
