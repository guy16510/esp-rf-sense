#include "ControlApi.h"

#include <cstring>
#include <cstdlib>

#include "AppConfig.h"
#include "ConfigStore.h"
#include "DeviceHealth.h"
#include "DeviceLogs.h"
#include "OtaManager.h"
#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "control_api";
constexpr size_t kMaxBodyLen = 1536;

ControlApi* selfOf(httpd_req_t* req) { return static_cast<ControlApi*>(req->user_ctx); }

esp_err_t sendJson(httpd_req_t* req, cJSON* root, const char* status) {
  char* out = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!out) {
    httpd_resp_set_status(req, "500 Internal Server Error");
    httpd_resp_sendstr(req, "{\"error\":\"serialize\"}");
    return ESP_OK;
  }
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json");
  esp_err_t err = httpd_resp_sendstr(req, out);
  cJSON_free(out);
  return err;
}

esp_err_t sendError(httpd_req_t* req, const char* status, const char* msg) {
  cJSON* root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "error", msg);
  return sendJson(req, root, status);
}

// Reads the request body into buf (NUL-terminated). Returns length or -1 on error/too large.
int readBody(httpd_req_t* req, char* buf, size_t cap) {
  if (req->content_len >= cap) return -1;
  int total = 0;
  while (total < static_cast<int>(req->content_len)) {
    int r = httpd_req_recv(req, buf + total, req->content_len - total);
    if (r <= 0) return -1;
    total += r;
  }
  buf[total] = '\0';
  return total;
}

void deferredRebootTask(void*) {
  vTaskDelay(pdMS_TO_TICKS(500));
  esp_restart();
}

void otaApplyTask(void*) {
  OtaManager::instance().apply();  // reboots on success; returns on failure
  vTaskDelete(nullptr);
}

const char* otaStateText(OtaState s) {
  switch (s) {
    case OtaState::Idle: return "idle";
    case OtaState::Checking: return "checking";
    case OtaState::UpdateAvailable: return "update_available";
    case OtaState::Applying: return "applying";
    case OtaState::ReadyToReboot: return "ready_to_reboot";
    case OtaState::Failed: return "failed";
  }
  return "unknown";
}

cJSON* buildHealthJson() {
  const HealthSnapshot s = DeviceHealth::instance().snapshot();
  cJSON* o = cJSON_CreateObject();
  cJSON_AddNumberToObject(o, "uptimeSeconds", s.uptimeSeconds);
  cJSON_AddStringToObject(o, "bootReason", s.bootReason);
  cJSON_AddNumberToObject(o, "bootCount", s.bootCount);
  cJSON_AddNumberToObject(o, "consecutiveFailedBoots", s.consecutiveFailedBoots);
  cJSON_AddNumberToObject(o, "freeHeap", s.freeHeap);
  cJSON_AddNumberToObject(o, "minFreeHeap", s.minFreeHeap);
  cJSON_AddNumberToObject(o, "psramFree", s.psramFree);
  cJSON_AddNumberToObject(o, "psramTotal", s.psramTotal);
  cJSON_AddNumberToObject(o, "csiFramesCaptured", static_cast<double>(s.csiFramesCaptured));
  cJSON_AddNumberToObject(o, "csiFramesQueued", s.csiFramesQueued);
  cJSON_AddNumberToObject(o, "csiQueueDrops", static_cast<double>(s.csiQueueDrops));
  cJSON_AddNumberToObject(o, "networkBatchesSent", static_cast<double>(s.networkBatchesSent));
  cJSON_AddNumberToObject(o, "networkSendFailures", static_cast<double>(s.networkSendFailures));
  cJSON_AddNumberToObject(o, "networkQueueDrops", static_cast<double>(s.networkQueueDrops));
  cJSON_AddNumberToObject(o, "networkBytesSent", static_cast<double>(s.networkBytesSent));
  cJSON_AddNumberToObject(o, "collectorPacketLossPpm", s.collectorPacketLossPpm);
  cJSON_AddNumberToObject(o, "pingRequests", static_cast<double>(s.pingRequests));
  cJSON_AddNumberToObject(o, "pingReplies", static_cast<double>(s.pingReplies));
  cJSON_AddNumberToObject(o, "wifiReconnectCount", s.wifiReconnectCount);
  cJSON_AddNumberToObject(o, "currentRssi", s.currentRssi);
  cJSON_AddNumberToObject(o, "watchdogEvents", s.watchdogEvents);
  cJSON_AddNumberToObject(o, "otaAttempts", s.otaAttempts);
  cJSON_AddNumberToObject(o, "otaSuccesses", s.otaSuccesses);
  cJSON_AddNumberToObject(o, "otaFailures", s.otaFailures);
  cJSON_AddNumberToObject(o, "rollbackCount", s.rollbackCount);
  cJSON_AddNumberToObject(o, "stackEncodeWords", s.stackEncodeWords);
  cJSON_AddNumberToObject(o, "stackNetworkWords", s.stackNetworkWords);
  cJSON_AddNumberToObject(o, "stackPingWords", s.stackPingWords);
  return o;
}

// --- handlers ---

esp_err_t statusGet(httpd_req_t* req) {
  ControlApi* self = selfOf(req);
  const BuildInfo bi = buildInfo();
  const DeviceConfig cfg = ConfigStore::instance().get();
  const OtaStatus ota = OtaManager::instance().status();

  cJSON* root = cJSON_CreateObject();
  cJSON_AddNumberToObject(root, "deviceId", self ? self->deviceId() : 0);
  cJSON_AddNumberToObject(root, "bootId", self ? self->bootId() : 0);
  cJSON* fw = cJSON_AddObjectToObject(root, "firmware");
  cJSON_AddStringToObject(fw, "version", bi.version);
  cJSON_AddStringToObject(fw, "gitCommit", bi.gitCommit);
  cJSON_AddStringToObject(fw, "buildTimestamp", bi.buildTimestamp);
  cJSON_AddStringToObject(fw, "partitionTableHash", bi.partitionTableHash);
  cJSON_AddStringToObject(fw, "target", bi.hardwareTarget);
  cJSON_AddStringToObject(fw, "board", kBoardId);
  cJSON_AddNumberToObject(fw, "protocolVersion", bi.protocolVersion);
  cJSON_AddStringToObject(fw, "apiVersion", bi.apiVersion);

  cJSON* cap = cJSON_AddObjectToObject(root, "capture");
  const bool active = self && self->hooksIsCapturing();
  cJSON_AddBoolToObject(cap, "active", active);
  cJSON_AddNumberToObject(cap, "mode", cfg.captureMode);

  cJSON* o = cJSON_AddObjectToObject(root, "ota");
  cJSON_AddStringToObject(o, "state", otaStateText(ota.state));
  cJSON_AddBoolToObject(o, "updateAvailable", ota.updateAvailable);
  cJSON_AddStringToObject(o, "availableVersion", ota.availableVersion);
  cJSON_AddStringToObject(o, "message", ota.message);

  cJSON_AddStringToObject(root, "deviceName", cfg.deviceName);
  return sendJson(req, root, "200 OK");
}

esp_err_t healthGet(httpd_req_t* req) { return sendJson(req, buildHealthJson(), "200 OK"); }

esp_err_t logsGet(httpd_req_t* req) {
  char query[96] = {};
  uint32_t after = 0;
  std::size_t limit = 80;
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
    char value[16] = {};
    if (httpd_query_key_value(query, "after", value, sizeof(value)) == ESP_OK) {
      after = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
    }
    if (httpd_query_key_value(query, "limit", value, sizeof(value)) == ESP_OK) {
      const unsigned long parsed = std::strtoul(value, nullptr, 10);
      if (parsed > 0 && parsed <= 96) limit = static_cast<std::size_t>(parsed);
    }
  }

  auto* entries = static_cast<DeviceLogEntry*>(std::calloc(limit, sizeof(DeviceLogEntry)));
  if (!entries) return sendError(req, "500 Internal Server Error", "log buffer allocation failed");
  const std::size_t count = DeviceLogs::instance().readSince(after, entries, limit);
  cJSON* root = cJSON_CreateObject();
  cJSON_AddNumberToObject(root, "latestSequence", DeviceLogs::instance().latestSequence());
  cJSON_AddNumberToObject(root, "dropped", DeviceLogs::instance().dropped());
  cJSON* arr = cJSON_AddArrayToObject(root, "entries");
  for (std::size_t i = 0; i < count; ++i) {
    cJSON* item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "sequence", entries[i].sequence);
    cJSON_AddNumberToObject(item, "uptimeMs", entries[i].uptimeMs);
    cJSON_AddStringToObject(item, "line", entries[i].line);
    cJSON_AddItemToArray(arr, item);
  }
  std::free(entries);
  return sendJson(req, root, "200 OK");
}

esp_err_t configGet(httpd_req_t* req) {
  const DeviceConfig c = ConfigStore::instance().get();
  cJSON* root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "deviceName", c.deviceName);
  cJSON_AddStringToObject(root, "wifiSsid", c.wifiSsid);
  cJSON_AddBoolToObject(root, "wifiPasswordSet", c.wifiPassword[0] != '\0');
  cJSON_AddStringToObject(root, "otaManifestUrl", c.otaManifestUrl);
  cJSON_AddStringToObject(root, "otaChannel", c.otaChannel);
  cJSON_AddStringToObject(root, "collectorHost", c.collectorHost);
  cJSON_AddNumberToObject(root, "collectorPort", c.collectorPort);
  cJSON_AddNumberToObject(root, "captureMode", c.captureMode);
  cJSON_AddNumberToObject(root, "pingPps", c.pingPps);
  cJSON_AddNumberToObject(root, "pingPayloadBytes", c.pingPayloadBytes);
  cJSON_AddNumberToObject(root, "pingTimeoutMs", c.pingTimeoutMs);
  cJSON_AddNumberToObject(root, "pingWarmupMs", c.pingWarmupMs);
  cJSON_AddBoolToObject(root, "otaScheduledEnabled", c.otaScheduledEnabled);
  cJSON_AddNumberToObject(root, "otaScheduledIntervalS", c.otaScheduledIntervalS);
  cJSON_AddBoolToObject(root, "otaAutoApply", c.otaAutoApply);
  cJSON_AddBoolToObject(root, "provisioned", c.provisioned);
  return sendJson(req, root, "200 OK");
}

void overlayString(cJSON* root, const char* key, char* dst, size_t cap) {
  const char* v = nullptr;
  cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (item && cJSON_IsString(item)) v = item->valuestring;
  if (v) {
    std::strncpy(dst, v, cap - 1);
    dst[cap - 1] = '\0';
  }
}
void overlayU16(cJSON* root, const char* key, uint16_t& dst) {
  cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (item && cJSON_IsNumber(item) && item->valuedouble >= 0) dst = static_cast<uint16_t>(item->valuedouble);
}
void overlayU32(cJSON* root, const char* key, uint32_t& dst) {
  cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (item && cJSON_IsNumber(item) && item->valuedouble >= 0) dst = static_cast<uint32_t>(item->valuedouble);
}
void overlayBool(cJSON* root, const char* key, bool& dst) {
  cJSON* item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (item && cJSON_IsBool(item)) dst = cJSON_IsTrue(item);
}

esp_err_t configPost(httpd_req_t* req) {
  char body[kMaxBodyLen];
  if (readBody(req, body, sizeof(body)) < 0) return sendError(req, "400 Bad Request", "body too large");
  cJSON* root = cJSON_Parse(body);
  if (!root) return sendError(req, "400 Bad Request", "invalid json");

  DeviceConfig c = ConfigStore::instance().get();
  overlayString(root, "wifiSsid", c.wifiSsid, sizeof(c.wifiSsid));
  overlayString(root, "wifiPassword", c.wifiPassword, sizeof(c.wifiPassword));
  overlayString(root, "otaManifestUrl", c.otaManifestUrl, sizeof(c.otaManifestUrl));
  overlayString(root, "otaChannel", c.otaChannel, sizeof(c.otaChannel));
  overlayString(root, "collectorHost", c.collectorHost, sizeof(c.collectorHost));
  overlayU16(root, "collectorPort", c.collectorPort);
  overlayString(root, "deviceName", c.deviceName, sizeof(c.deviceName));
  uint16_t mode = c.captureMode;
  overlayU16(root, "captureMode", mode);
  c.captureMode = static_cast<uint8_t>(mode);
  overlayU16(root, "pingPps", c.pingPps);
  overlayU16(root, "pingPayloadBytes", c.pingPayloadBytes);
  overlayU16(root, "pingTimeoutMs", c.pingTimeoutMs);
  overlayU32(root, "pingWarmupMs", c.pingWarmupMs);
  overlayBool(root, "otaScheduledEnabled", c.otaScheduledEnabled);
  overlayU32(root, "otaScheduledIntervalS", c.otaScheduledIntervalS);
  overlayBool(root, "otaAutoApply", c.otaAutoApply);
  cJSON_Delete(root);

  if (c.wifiSsid[0] != '\0' && c.collectorHost[0] != '\0') {
    c.provisioned = true;
  }
  esp_err_t err = ConfigStore::instance().save(c);
  if (err != ESP_OK) return sendError(req, "400 Bad Request", "config validation failed");

  cJSON* ok = cJSON_CreateObject();
  cJSON_AddBoolToObject(ok, "saved", true);
  return sendJson(req, ok, "200 OK");
}

esp_err_t captureStartPost(httpd_req_t* req) {
  ControlApi* self = selfOf(req);
  const bool ok = self && self->hooksStartCapture();
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "capturing", ok);
  return sendJson(req, root, ok ? "200 OK" : "409 Conflict");
}

esp_err_t captureStopPost(httpd_req_t* req) {
  ControlApi* self = selfOf(req);
  const bool ok = self && self->hooksStopCapture();
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "capturing", ok ? false : true);
  return sendJson(req, root, "200 OK");
}

esp_err_t otaCheckPost(httpd_req_t* req) {
  const DeviceConfig c = ConfigStore::instance().get();
  if (c.otaManifestUrl[0] == '\0') return sendError(req, "400 Bad Request", "no manifest url");
  const bool available = OtaManager::instance().check(c.otaManifestUrl);
  const OtaStatus s = OtaManager::instance().status();
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "updateAvailable", available);
  cJSON_AddStringToObject(root, "state", otaStateText(s.state));
  cJSON_AddStringToObject(root, "availableVersion", s.availableVersion);
  cJSON_AddStringToObject(root, "message", s.message);
  return sendJson(req, root, "200 OK");
}

esp_err_t otaApplyPost(httpd_req_t* req) {
  const OtaStatus s = OtaManager::instance().status();
  if (!s.updateAvailable) return sendError(req, "409 Conflict", "no validated update; run check first");
  if (OtaManager::instance().isBusy()) return sendError(req, "409 Conflict", "ota in progress");
  xTaskCreate(otaApplyTask, "ota_apply", 8192, nullptr, 5, nullptr);
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "applying", true);
  cJSON_AddStringToObject(root, "note", "device will reboot into the new slot on success");
  return sendJson(req, root, "202 Accepted");
}

esp_err_t rebootPost(httpd_req_t* req) {
  xTaskCreate(deferredRebootTask, "reboot", 2048, nullptr, 5, nullptr);
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "rebooting", true);
  return sendJson(req, root, "202 Accepted");
}

esp_err_t provisioningResetPost(httpd_req_t* req) {
  esp_err_t err = ConfigStore::instance().clearProvisioning();
  if (err != ESP_OK) return sendError(req, "500 Internal Server Error", "nvs clear failed");
  xTaskCreate(deferredRebootTask, "reboot", 2048, nullptr, 5, nullptr);
  cJSON* root = cJSON_CreateObject();
  cJSON_AddBoolToObject(root, "provisioningCleared", true);
  cJSON_AddStringToObject(root, "note", "rebooting into SoftAP setup");
  return sendJson(req, root, "202 Accepted");
}

}  // namespace

// Friend-ish accessors used by the static handlers (kept here to avoid widening the header).
bool ControlApi::hooksStartCapture() { return hooks_.startCapture ? hooks_.startCapture() : false; }
bool ControlApi::hooksStopCapture() { return hooks_.stopCapture ? hooks_.stopCapture() : false; }
bool ControlApi::hooksIsCapturing() const {
  return hooks_.isCapturing ? hooks_.isCapturing() : false;
}
ControlApi& ControlApi::instance() {
  static ControlApi a;
  return a;
}

esp_err_t ControlApi::start(uint16_t port) {
  if (server_) return ESP_OK;
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = port;
  config.max_uri_handlers = 16;
  config.lru_purge_enable = true;
  config.stack_size = 8192;

  httpd_handle_t handle = nullptr;
  esp_err_t err = httpd_start(&handle, &config);
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "httpd_start failed: %s", esp_err_to_name(err));
    return err;
  }
  server_ = handle;

  auto reg = [&](const char* uri, httpd_method_t method, esp_err_t (*h)(httpd_req_t*)) {
    httpd_uri_t u = {};
    u.uri = uri;
    u.method = method;
    u.handler = h;
    u.user_ctx = this;
    httpd_register_uri_handler(handle, &u);
  };

  reg("/api/v1/status", HTTP_GET, statusGet);
  reg("/api/v1/health", HTTP_GET, healthGet);
  reg("/api/v1/logs", HTTP_GET, logsGet);
  reg("/api/v1/config", HTTP_GET, configGet);
  reg("/api/v1/config", HTTP_POST, configPost);
  reg("/api/v1/capture/start", HTTP_POST, captureStartPost);
  reg("/api/v1/capture/stop", HTTP_POST, captureStopPost);
  reg("/api/v1/ota/check", HTTP_POST, otaCheckPost);
  reg("/api/v1/ota/apply", HTTP_POST, otaApplyPost);
  reg("/api/v1/reboot", HTTP_POST, rebootPost);
  reg("/api/v1/provisioning/reset", HTTP_POST, provisioningResetPost);

  ESP_LOGI(kTag, "control api listening on :%u/api/v1", port);
  return ESP_OK;
}

esp_err_t ControlApi::stop() {
  if (!server_) return ESP_OK;
  esp_err_t err = httpd_stop(static_cast<httpd_handle_t>(server_));
  server_ = nullptr;
  return err;
}

}  // namespace rfsense
