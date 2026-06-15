// Owns the esp_wifi driver: station connect/reconnect + SoftAP control for provisioning.
// Only one role is active at a time (SoftAP during setup, STA during normal operation).
#pragma once

#include <functional>
#include <string>

#include "esp_err.h"

namespace rfsense {

class WifiManager {
 public:
  static WifiManager& instance();

  using GotIpHandler = std::function<void(const std::string& ip)>;

  // One-time driver init (netif, default STA+AP interfaces, event handlers). Requires the
  // default event loop and NVS to already be initialized.
  esp_err_t init();

  // Station mode. Connects and auto-reconnects with bounded backoff. ssid/password come from
  // provisioned config; the password is never logged.
  esp_err_t startStation(const std::string& ssid, const std::string& password);

  // SoftAP for headless provisioning. open=false uses WPA2 with the given password.
  esp_err_t startSoftAp(const std::string& ssid, const std::string& password, uint8_t channel = 1);
  esp_err_t stopSoftAp();

  bool isConnected() const;
  // Blocks up to timeoutMs for an IP. Returns true if connected.
  bool waitForIp(uint32_t timeoutMs);
  std::string ipAddress() const;
  int8_t currentRssi() const;

  void onGotIp(GotIpHandler handler) { gotIpHandler_ = std::move(handler); }

 private:
  WifiManager() = default;
  void handleWifiEvent(int32_t id, void* data);
  void handleIpEvent(int32_t id, void* data);
  static void eventTrampoline(void* arg, const char* base, int32_t id, void* data);

  void* staNetif_ = nullptr;
  void* apNetif_ = nullptr;
  void* ipEventGroup_ = nullptr;  // EventGroupHandle_t
  bool stationActive_ = false;
  bool stopping_ = false;
  uint32_t reconnectAttempts_ = 0;
  GotIpHandler gotIpHandler_;
};

}  // namespace rfsense
