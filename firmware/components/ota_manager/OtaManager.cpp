#include "OtaManager.h"

#include <cstring>

#include "AppConfig.h"
#include "BootGuard.h"
#include "esp_app_format.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "ota_manager";
constexpr size_t kManifestBufCap = 2048;
constexpr uint32_t kMinFreeHeapBytes = 48 * 1024;  // refuse OTA below this headroom

#ifdef CONFIG_RF_SENSE_OTA_ALLOW_INSECURE_HTTP
constexpr bool kAllowInsecureHttp = true;
#else
constexpr bool kAllowInsecureHttp = false;
#endif

// Embedded private root CA for the local OTA server (see certs/ota_root_ca.pem). When the file
// holds only the placeholder comment the bytes are effectively empty and we fall back to the
// public certificate bundle.
extern "C" const uint8_t ota_root_ca_pem_start[] asm("_binary_ota_root_ca_pem_start");
extern "C" const uint8_t ota_root_ca_pem_end[] asm("_binary_ota_root_ca_pem_end");

bool embeddedCaPresent() {
  const size_t len = ota_root_ca_pem_end - ota_root_ca_pem_start;
  // A real PEM begins with "-----BEGIN". Anything shorter is the placeholder.
  return len > 32 && std::memcmp(ota_root_ca_pem_start, "-----BEGIN", 10) == 0;
}

void applyTls(esp_http_client_config_t& cfg) {
  if (embeddedCaPresent()) {
    cfg.cert_pem = reinterpret_cast<const char*>(ota_root_ca_pem_start);
  } else {
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
  }
}

// Incremental SHA-256 fed from the OTA HTTP data stream. The advanced esp_https_ota path
// reads body bytes via esp_http_client, which fires HTTP_EVENT_ON_DATA for each chunk.
struct ShaCtx {
  mbedtls_sha256_context sha;
  bool started = false;
};

esp_err_t shaEventHandler(esp_http_client_event_t* evt) {
  if (evt->event_id == HTTP_EVENT_ON_DATA && evt->user_data && evt->data_len > 0) {
    auto* ctx = static_cast<ShaCtx*>(evt->user_data);
    mbedtls_sha256_update(&ctx->sha, static_cast<const uint8_t*>(evt->data),
                          static_cast<size_t>(evt->data_len));
  }
  return ESP_OK;
}

void toHex(const uint8_t* digest, size_t n, char* out) {
  static const char* k = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) {
    out[i * 2] = k[digest[i] >> 4];
    out[i * 2 + 1] = k[digest[i] & 0x0F];
  }
  out[n * 2] = '\0';
}
}  // namespace

OtaManager& OtaManager::instance() {
  static OtaManager m;
  return m;
}

void OtaManager::configure(const char* currentVersion, uint32_t flashSizeBytes,
                           uint32_t otaSlotSizeBytes) {
  std::strncpy(currentVersion_, currentVersion ? currentVersion : "0.0.0",
               sizeof(currentVersion_) - 1);
  currentVersion_[sizeof(currentVersion_) - 1] = '\0';
  flashSizeBytes_ = flashSizeBytes;
  otaSlotSizeBytes_ = otaSlotSizeBytes;
}

ManifestContext OtaManager::context() const {
  ManifestContext ctx;
  ctx.supportedSchemaVersion = 1;
  ctx.expectedProject = "rf-sense";
  ctx.expectedTarget = CONFIG_IDF_TARGET;
  ctx.expectedBoard = kBoardId;
  ctx.expectedFlashSizeBytes = flashSizeBytes_;
  ctx.otaSlotSizeBytes = otaSlotSizeBytes_;
  ctx.currentVersion = parseSemVer(currentVersion_);
  ctx.allowInsecureHttp = kAllowInsecureHttp;
  return ctx;
}

void OtaManager::setMessage(OtaState state, const char* msg) {
  state_ = state;
  std::strncpy(message_, msg ? msg : "", sizeof(message_) - 1);
  message_[sizeof(message_) - 1] = '\0';
}

bool OtaManager::downloadManifest(const char* url, char* buf, size_t cap, size_t& outLen) {
  outLen = 0;
  esp_http_client_config_t cfg = {};
  cfg.url = url;
  cfg.timeout_ms = 10000;
  applyTls(cfg);

  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (!client) return false;

  bool ok = false;
  do {
    if (esp_http_client_open(client, 0) != ESP_OK) break;
    esp_http_client_fetch_headers(client);
    if (esp_http_client_get_status_code(client) != 200) break;

    int total = 0;
    while (total < static_cast<int>(cap) - 1) {
      int r = esp_http_client_read(client, buf + total, static_cast<int>(cap) - 1 - total);
      if (r < 0) break;
      if (r == 0) {
        ok = true;
        break;
      }
      total += r;
    }
    buf[total > 0 ? total : 0] = '\0';
    outLen = static_cast<size_t>(total);
  } while (false);

  esp_http_client_close(client);
  esp_http_client_cleanup(client);
  return ok && outLen > 0;
}

bool OtaManager::check(const char* manifestUrl) {
  bool expected = false;
  if (!busy_.compare_exchange_strong(expected, true)) {
    setMessage(state_, "ota busy");
    return false;
  }
  struct Guard {
    std::atomic<bool>& b;
    ~Guard() { b.store(false); }
  } guard{busy_};

  state_ = OtaState::Checking;
  pendingValid_ = false;

  char buf[kManifestBufCap];
  size_t len = 0;
  if (!downloadManifest(manifestUrl, buf, sizeof(buf), len)) {
    lastReject_ = ManifestReject::None;
    setMessage(OtaState::Failed, "manifest download failed");
    ESP_LOGW(kTag, "manifest download failed from %s", manifestUrl);
    return false;
  }

  OtaManifest m;
  if (!parseManifest(buf, len, m)) {
    setMessage(OtaState::Failed, "manifest parse failed");
    return false;
  }

  lastReject_ = validateManifest(m, context());
  if (lastReject_ != ManifestReject::None) {
    // NotNewer is a normal "nothing to do", not an error.
    state_ = (lastReject_ == ManifestReject::NotNewer) ? OtaState::Idle : OtaState::Failed;
    setMessage(state_, rejectReasonText(lastReject_));
    ESP_LOGI(kTag, "manifest rejected: %s (version %s)", rejectReasonText(lastReject_), m.version);
    return false;
  }

  pending_ = m;
  pendingValid_ = true;
  state_ = OtaState::UpdateAvailable;
  std::strncpy(message_, "update available", sizeof(message_) - 1);
  ESP_LOGI(kTag, "update available: %s -> %s", currentVersion_, m.version);
  return true;
}

bool OtaManager::apply() {
  bool expected = false;
  if (!busy_.compare_exchange_strong(expected, true)) {
    setMessage(state_, "ota busy");
    return false;
  }
  struct Guard {
    std::atomic<bool>& b;
    ~Guard() { b.store(false); }
  } guard{busy_};

  if (!pendingValid_) {
    setMessage(OtaState::Failed, "no validated manifest");
    return false;
  }
  if (esp_get_free_heap_size() < kMinFreeHeapBytes) {
    setMessage(OtaState::Failed, "insufficient heap for ota");
    return false;
  }

  state_ = OtaState::Applying;
  BootGuard::instance().recordOtaAttempt();

  // Stop sensing and tell the collector we are pausing before we disturb the radio/flash.
  if (maintenanceHook_) maintenanceHook_();

  ShaCtx shaCtx;
  mbedtls_sha256_init(&shaCtx.sha);
  mbedtls_sha256_starts(&shaCtx.sha, 0);
  shaCtx.started = true;

  esp_http_client_config_t httpCfg = {};
  httpCfg.url = pending_.firmwareUrl;
  httpCfg.timeout_ms = 30000;
  httpCfg.keep_alive_enable = true;
  httpCfg.event_handler = shaEventHandler;
  httpCfg.user_data = &shaCtx;
  applyTls(httpCfg);

  esp_https_ota_config_t otaCfg = {};
  otaCfg.http_config = &httpCfg;

  esp_https_ota_handle_t handle = nullptr;
  esp_err_t err = esp_https_ota_begin(&otaCfg, &handle);
  if (err != ESP_OK || handle == nullptr) {
    mbedtls_sha256_free(&shaCtx.sha);
    BootGuard::instance().recordOtaFailure();
    setMessage(OtaState::Failed, "ota begin failed");
    ESP_LOGE(kTag, "esp_https_ota_begin: %s", esp_err_to_name(err));
    return false;
  }

  while (true) {
    err = esp_https_ota_perform(handle);
    if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) break;
  }

  bool success = false;
  do {
    if (err != ESP_OK) {
      ESP_LOGE(kTag, "esp_https_ota_perform: %s", esp_err_to_name(err));
      break;
    }
    if (!esp_https_ota_is_complete_data_received(handle)) {
      ESP_LOGE(kTag, "incomplete image received");
      break;
    }

    uint8_t digest[32];
    mbedtls_sha256_finish(&shaCtx.sha, digest);
    char hex[65];
    toHex(digest, sizeof(digest), hex);
    if (std::strcmp(hex, pending_.sha256) != 0) {
      ESP_LOGE(kTag, "sha256 mismatch: got %s want %s", hex, pending_.sha256);
      break;
    }
    success = true;
  } while (false);

  mbedtls_sha256_free(&shaCtx.sha);

  if (!success) {
    esp_https_ota_abort(handle);
    BootGuard::instance().recordOtaFailure();
    setMessage(OtaState::Failed, "ota verify failed");
    return false;
  }

  // finish() runs esp_ota_end + sets the boot partition only now that the hash matched.
  err = esp_https_ota_finish(handle);
  if (err != ESP_OK) {
    BootGuard::instance().recordOtaFailure();
    setMessage(OtaState::Failed, "ota finish failed");
    ESP_LOGE(kTag, "esp_https_ota_finish: %s", esp_err_to_name(err));
    return false;
  }

  BootGuard::instance().recordOtaSuccess();
  setMessage(OtaState::ReadyToReboot, "verified; rebooting into new slot");
  ESP_LOGI(kTag, "OTA verified (%s); rebooting", pending_.version);
  vTaskDelay(pdMS_TO_TICKS(250));
  esp_restart();
  return true;  // not reached
}

OtaStatus OtaManager::status() const {
  OtaStatus s;
  s.state = state_;
  s.updateAvailable = pendingValid_;
  s.lastReject = lastReject_;
  if (pendingValid_) {
    std::strncpy(s.availableVersion, pending_.version, sizeof(s.availableVersion) - 1);
  }
  std::strncpy(s.message, message_, sizeof(s.message) - 1);
  return s;
}

}  // namespace rfsense
