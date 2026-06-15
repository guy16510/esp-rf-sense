#include "MdnsService.h"

#include <cstdio>

#include "esp_log.h"
#include "mdns.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "mdns";
constexpr char kServiceType[] = "_http";
constexpr char kProto[] = "_tcp";
constexpr uint16_t kHttpPort = 80;
}  // namespace

MdnsService& MdnsService::instance() {
  static MdnsService m;
  return m;
}

esp_err_t MdnsService::start(const std::string& hostname, const std::string& instanceName,
                             const std::string& version, uint32_t deviceId,
                             const std::string& target) {
  esp_err_t err = mdns_init();
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "mdns_init failed: %s", esp_err_to_name(err));
    return err;
  }
  mdns_hostname_set(hostname.c_str());
  mdns_instance_name_set(instanceName.c_str());

  char deviceIdHex[16];
  std::snprintf(deviceIdHex, sizeof(deviceIdHex), "%08lx", static_cast<unsigned long>(deviceId));

  mdns_txt_item_t txt[] = {
      {"fw", version.c_str()},   {"api", "v1"},        {"id", deviceIdHex},
      {"target", target.c_str()}, {"capture", "idle"}, {"ota", "idle"},
  };
  err = mdns_service_add(instanceName.c_str(), kServiceType, kProto, kHttpPort, txt,
                         sizeof(txt) / sizeof(txt[0]));
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "mdns_service_add failed: %s", esp_err_to_name(err));
    return err;
  }
  started_ = true;
  ESP_LOGI(kTag, "advertising %s.local (_http._tcp:%u)", hostname.c_str(), kHttpPort);
  return ESP_OK;
}

void MdnsService::updateState(bool capturing, const std::string& otaState) {
  if (!started_) return;
  mdns_service_txt_item_set(kServiceType, kProto, "capture", capturing ? "active" : "idle");
  mdns_service_txt_item_set(kServiceType, kProto, "ota", otaState.c_str());
}

esp_err_t MdnsService::stop() {
  if (!started_) return ESP_OK;
  mdns_free();
  started_ = false;
  return ESP_OK;
}

}  // namespace rfsense
