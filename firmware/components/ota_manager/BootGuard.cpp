#include "BootGuard.h"

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "boot_guard";
constexpr char kNamespace[] = "rfsense_boot";
constexpr char kKeyBootCount[] = "bootCount";
constexpr char kKeyFailedBoots[] = "failedBoots";
constexpr char kKeyRollbacks[] = "rollbacks";
constexpr char kKeyOtaAttempts[] = "otaAttempts";
constexpr char kKeyOtaOk[] = "otaOk";
constexpr char kKeyOtaFail[] = "otaFail";

#ifdef CONFIG_RF_SENSE_BOOTLOOP_THRESHOLD
constexpr uint32_t kBootLoopThreshold = CONFIG_RF_SENSE_BOOTLOOP_THRESHOLD;
#else
constexpr uint32_t kBootLoopThreshold = 3;
#endif

uint32_t readU32(nvs_handle_t h, const char* key) {
  uint32_t v = 0;
  nvs_get_u32(h, key, &v);
  return v;
}
}  // namespace

BootGuard& BootGuard::instance() {
  static BootGuard g;
  return g;
}

esp_err_t BootGuard::begin() {
  nvs_handle_t h;
  esp_err_t err = nvs_open(kNamespace, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  stats_.bootCount = readU32(h, kKeyBootCount) + 1;
  stats_.consecutiveFailedBoots = readU32(h, kKeyFailedBoots) + 1;  // cleared by confirmHealthy
  stats_.rollbackCount = readU32(h, kKeyRollbacks);
  stats_.otaAttempts = readU32(h, kKeyOtaAttempts);
  stats_.otaSuccesses = readU32(h, kKeyOtaOk);
  stats_.otaFailures = readU32(h, kKeyOtaFail);

  nvs_set_u32(h, kKeyBootCount, stats_.bootCount);
  nvs_set_u32(h, kKeyFailedBoots, stats_.consecutiveFailedBoots);
  nvs_commit(h);
  nvs_close(h);
  loaded_ = true;

  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (running && esp_ota_get_state_partition(running, &state) == ESP_OK) {
    pendingVerify_ = (state == ESP_OTA_IMG_PENDING_VERIFY);
  }
  ESP_LOGI(kTag, "boot #%lu (consecutive unverified=%lu) pendingVerify=%d",
           static_cast<unsigned long>(stats_.bootCount),
           static_cast<unsigned long>(stats_.consecutiveFailedBoots), pendingVerify_);

  mirrorToHealth();
  return ESP_OK;
}

bool BootGuard::inBootLoop() const {
  return stats_.consecutiveFailedBoots >= kBootLoopThreshold;
}

esp_err_t BootGuard::confirmHealthy() {
  if (pendingVerify_) {
    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err != ESP_OK) {
      ESP_LOGE(kTag, "mark_app_valid failed: %s", esp_err_to_name(err));
      return err;
    }
    pendingVerify_ = false;
    ESP_LOGI(kTag, "running app marked valid; rollback cancelled");
  }
  stats_.consecutiveFailedBoots = 0;
  return persist();
}

esp_err_t BootGuard::rollbackNow() {
  stats_.rollbackCount += 1;
  persist();
  mirrorToHealth();
  ESP_LOGW(kTag, "post-OTA validation failed; rolling back to previous slot");
  // Does not return on success.
  return esp_ota_mark_app_invalid_rollback_and_reboot();
}

void BootGuard::recordOtaAttempt() {
  stats_.otaAttempts += 1;
  persist();
  mirrorToHealth();
}

void BootGuard::recordOtaSuccess() {
  stats_.otaSuccesses += 1;
  persist();
  mirrorToHealth();
}

void BootGuard::recordOtaFailure() {
  stats_.otaFailures += 1;
  persist();
  mirrorToHealth();
}

esp_err_t BootGuard::persist() {
  nvs_handle_t h;
  esp_err_t err = nvs_open(kNamespace, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;
  nvs_set_u32(h, kKeyBootCount, stats_.bootCount);
  nvs_set_u32(h, kKeyFailedBoots, stats_.consecutiveFailedBoots);
  nvs_set_u32(h, kKeyRollbacks, stats_.rollbackCount);
  nvs_set_u32(h, kKeyOtaAttempts, stats_.otaAttempts);
  nvs_set_u32(h, kKeyOtaOk, stats_.otaSuccesses);
  nvs_set_u32(h, kKeyOtaFail, stats_.otaFailures);
  err = nvs_commit(h);
  nvs_close(h);
  return err;
}

void BootGuard::mirrorToHealth() { DeviceHealth::instance().setPersistentStats(stats_); }

}  // namespace rfsense
