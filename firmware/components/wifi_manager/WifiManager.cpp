#include "WifiManager.h"

#include <cstring>

#include "DeviceHealth.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "wifi_manager";
constexpr int kGotIpBit = BIT0;
constexpr uint32_t kMaxBackoffMs = 30000;
}  // namespace

WifiManager& WifiManager::instance() {
  static WifiManager m;
  return m;
}

void WifiManager::eventTrampoline(void* arg, const char* base, int32_t id, void* data) {
  auto* self = static_cast<WifiManager*>(arg);
  if (std::strcmp(base, WIFI_EVENT) == 0) {
    self->handleWifiEvent(id, data);
  } else if (std::strcmp(base, IP_EVENT) == 0) {
    self->handleIpEvent(id, data);
  }
}

esp_err_t WifiManager::init() {
  ESP_RETURN_ON_ERROR(esp_netif_init(), kTag, "netif_init");
  staNetif_ = esp_netif_create_default_wifi_sta();
  apNetif_ = esp_netif_create_default_wifi_ap();

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  ESP_RETURN_ON_ERROR(esp_wifi_init(&cfg), kTag, "wifi_init");

  ipEventGroup_ = xEventGroupCreate();

  ESP_RETURN_ON_ERROR(
      esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &eventTrampoline, this,
                                          nullptr),
      kTag, "reg wifi evt");
  ESP_RETURN_ON_ERROR(
      esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &eventTrampoline, this,
                                          nullptr),
      kTag, "reg ip evt");

  ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), kTag, "set_storage");
  ESP_LOGI(kTag, "wifi driver initialized");
  return ESP_OK;
}

esp_err_t WifiManager::startStation(const std::string& ssid, const std::string& password) {
  if (ssid.empty() || ssid.size() > 32) {
    return ESP_ERR_INVALID_ARG;
  }
  stopping_ = false;
  reconnectAttempts_ = 0;

  wifi_config_t wc{};
  std::strncpy(reinterpret_cast<char*>(wc.sta.ssid), ssid.c_str(), sizeof(wc.sta.ssid) - 1);
  std::strncpy(reinterpret_cast<char*>(wc.sta.password), password.c_str(),
               sizeof(wc.sta.password) - 1);
  wc.sta.threshold.authmode = password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
  wc.sta.pmf_cfg.capable = true;
  wc.sta.pmf_cfg.required = false;

  ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), kTag, "set_mode sta");
  ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wc), kTag, "set_config sta");
  ESP_RETURN_ON_ERROR(esp_wifi_start(), kTag, "wifi_start");
  stationActive_ = true;
  // Connect to '%s' — never log the password.
  ESP_LOGI(kTag, "connecting to SSID '%s'", ssid.c_str());
  return esp_wifi_connect();
}

esp_err_t WifiManager::startSoftAp(const std::string& ssid, const std::string& password,
                                   uint8_t channel) {
  stationActive_ = false;
  wifi_config_t wc{};
  std::strncpy(reinterpret_cast<char*>(wc.ap.ssid), ssid.c_str(), sizeof(wc.ap.ssid) - 1);
  wc.ap.ssid_len = static_cast<uint8_t>(ssid.size());
  wc.ap.channel = channel;
  wc.ap.max_connection = 2;
  if (password.size() >= 8) {
    std::strncpy(reinterpret_cast<char*>(wc.ap.password), password.c_str(),
                 sizeof(wc.ap.password) - 1);
    wc.ap.authmode = WIFI_AUTH_WPA2_PSK;
  } else {
    wc.ap.authmode = WIFI_AUTH_OPEN;
  }

  ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), kTag, "set_mode ap");
  ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &wc), kTag, "set_config ap");
  ESP_RETURN_ON_ERROR(esp_wifi_start(), kTag, "wifi_start ap");
  ESP_LOGI(kTag, "SoftAP '%s' started on channel %u", ssid.c_str(), channel);
  return ESP_OK;
}

esp_err_t WifiManager::stopSoftAp() {
  esp_err_t err = esp_wifi_stop();
  ESP_LOGI(kTag, "SoftAP stopped");
  return err;
}

void WifiManager::handleWifiEvent(int32_t id, void* /*data*/) {
  switch (id) {
    case WIFI_EVENT_STA_START:
      esp_wifi_connect();
      break;
    case WIFI_EVENT_STA_DISCONNECTED: {
      if (!stationActive_ || stopping_) {
        break;
      }
      xEventGroupClearBits(static_cast<EventGroupHandle_t>(ipEventGroup_), kGotIpBit);
      DeviceHealth::instance().incWifiReconnect();
      ++reconnectAttempts_;
      uint32_t backoff = 500u * reconnectAttempts_;
      if (backoff > kMaxBackoffMs) backoff = kMaxBackoffMs;
      ESP_LOGW(kTag, "disconnected; reconnect attempt %u in %u ms",
               static_cast<unsigned>(reconnectAttempts_), static_cast<unsigned>(backoff));
      vTaskDelay(pdMS_TO_TICKS(backoff));
      esp_wifi_connect();
      break;
    }
    default:
      break;
  }
}

void WifiManager::handleIpEvent(int32_t id, void* data) {
  if (id != IP_EVENT_STA_GOT_IP) {
    return;
  }
  reconnectAttempts_ = 0;
  auto* event = static_cast<ip_event_got_ip_t*>(data);
  char ip[16];
  esp_ip4addr_ntoa(&event->ip_info.ip, ip, sizeof(ip));
  ESP_LOGI(kTag, "got IP %s", ip);
  xEventGroupSetBits(static_cast<EventGroupHandle_t>(ipEventGroup_), kGotIpBit);
  if (gotIpHandler_) {
    gotIpHandler_(std::string(ip));
  }
}

bool WifiManager::isConnected() const {
  if (ipEventGroup_ == nullptr) return false;
  const EventBits_t bits = xEventGroupGetBits(static_cast<EventGroupHandle_t>(ipEventGroup_));
  return (bits & kGotIpBit) != 0;
}

bool WifiManager::waitForIp(uint32_t timeoutMs) {
  if (ipEventGroup_ == nullptr) return false;
  const EventBits_t bits =
      xEventGroupWaitBits(static_cast<EventGroupHandle_t>(ipEventGroup_), kGotIpBit, pdFALSE,
                          pdTRUE, pdMS_TO_TICKS(timeoutMs));
  return (bits & kGotIpBit) != 0;
}

std::string WifiManager::ipAddress() const {
  if (staNetif_ == nullptr) return {};
  esp_netif_ip_info_t info{};
  if (esp_netif_get_ip_info(static_cast<esp_netif_t*>(staNetif_), &info) != ESP_OK) {
    return {};
  }
  char ip[16];
  esp_ip4addr_ntoa(&info.ip, ip, sizeof(ip));
  return std::string(ip);
}

int8_t WifiManager::currentRssi() const {
  int rssi = 0;
  if (esp_wifi_sta_get_rssi(&rssi) == ESP_OK) {
    return static_cast<int8_t>(rssi);
  }
  return 0;
}

}  // namespace rfsense
