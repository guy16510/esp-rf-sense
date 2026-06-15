#include "ConfigStore.h"

#include <cstring>

#include "ConfigCodec.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "config_store";
constexpr char kNamespace[] = "rfsense";
constexpr char kBlobKey[] = "cfg.v1";

struct Lock {
  explicit Lock(SemaphoreHandle_t m) : m_(m) {
    if (m_) xSemaphoreTake(m_, portMAX_DELAY);
  }
  ~Lock() {
    if (m_) xSemaphoreGive(m_);
  }
  SemaphoreHandle_t m_;
};
}  // namespace

ConfigStore& ConfigStore::instance() {
  static ConfigStore store;
  return store;
}

esp_err_t ConfigStore::init() {
  if (initialized_) {
    return ESP_OK;
  }
  if (mutex_ == nullptr) {
    mutex_ = xSemaphoreCreateMutex();
    if (mutex_ == nullptr) {
      return ESP_ERR_NO_MEM;
    }
  }
  const esp_err_t err = load();
  initialized_ = (err == ESP_OK);
  return err;
}

esp_err_t ConfigStore::load() {
  Lock lock(static_cast<SemaphoreHandle_t>(mutex_));
  nvs_handle_t handle;
  esp_err_t err = nvs_open(kNamespace, NVS_READONLY, &handle);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    cfg_ = DeviceConfig{};  // first boot: defaults, unprovisioned
    return ESP_OK;
  }
  if (err != ESP_OK) {
    return err;
  }

  uint8_t blob[ConfigCodec::kMaxBlobSize];
  size_t len = sizeof(blob);
  err = nvs_get_blob(handle, kBlobKey, blob, &len);
  nvs_close(handle);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    cfg_ = DeviceConfig{};
    return ESP_OK;
  }
  if (err != ESP_OK) {
    return err;
  }

  DeviceConfig parsed;
  if (!ConfigCodec::decode(blob, len, parsed)) {
    ESP_LOGW(kTag, "stored config failed decode/CRC; reverting to defaults");
    cfg_ = DeviceConfig{};
    return ESP_OK;
  }
  cfg_ = parsed;
  ESP_LOGI(kTag, "loaded config (provisioned=%d, ssid_set=%d)", cfg_.provisioned,
           cfg_.wifiSsid[0] != 0);
  return ESP_OK;
}

DeviceConfig ConfigStore::get() const {
  Lock lock(static_cast<SemaphoreHandle_t>(mutex_));
  return cfg_;
}

esp_err_t ConfigStore::save(const DeviceConfig& cfg) {
  const char* error = nullptr;
  if (!ConfigCodec::validate(cfg, &error)) {
    ESP_LOGE(kTag, "config validation failed: %s", error ? error : "unknown");
    return ESP_ERR_INVALID_ARG;
  }

  uint8_t blob[ConfigCodec::kMaxBlobSize];
  const size_t n = ConfigCodec::encode(cfg, blob, sizeof(blob));
  if (n == 0) {
    return ESP_ERR_INVALID_SIZE;
  }

  Lock lock(static_cast<SemaphoreHandle_t>(mutex_));
  nvs_handle_t handle;
  esp_err_t err = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (err != ESP_OK) {
    return err;
  }
  err = nvs_set_blob(handle, kBlobKey, blob, n);
  if (err == ESP_OK) {
    err = nvs_commit(handle);
  }
  nvs_close(handle);
  if (err == ESP_OK) {
    cfg_ = cfg;
    ESP_LOGI(kTag, "config saved (%u bytes)", static_cast<unsigned>(n));
  }
  return err;
}

esp_err_t ConfigStore::clearProvisioning() {
  Lock lock(static_cast<SemaphoreHandle_t>(mutex_));
  nvs_handle_t handle;
  esp_err_t err = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (err != ESP_OK) {
    return err;
  }
  err = nvs_erase_key(handle, kBlobKey);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    err = ESP_OK;
  }
  if (err == ESP_OK) {
    err = nvs_commit(handle);
  }
  nvs_close(handle);
  if (err == ESP_OK) {
    cfg_ = DeviceConfig{};
    ESP_LOGW(kTag, "provisioning cleared; will reboot into SoftAP setup");
  }
  return err;
}

bool ConfigStore::isProvisioned() const {
  Lock lock(static_cast<SemaphoreHandle_t>(mutex_));
  return ConfigCodec::isComplete(cfg_);
}

}  // namespace rfsense
