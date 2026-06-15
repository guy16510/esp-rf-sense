#include "Provisioning.h"

#include <cstdlib>
#include <cstring>

#include "ConfigStore.h"
#include "WifiManager.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "provisioning";
constexpr size_t kMaxBodyLen = 2048;

const char kSetupPage[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>RF-Sense setup</title>"
    "<style>body{font-family:sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem}"
    "label{display:block;margin:.6rem 0 .2rem;font-weight:600}"
    "input,select{width:100%;padding:.4rem;box-sizing:border-box}"
    "button{margin-top:1rem;padding:.6rem 1rem}</style></head><body>"
    "<h1>RF-Sense device setup</h1>"
    "<form method=POST action=/save>"
    "<label>Wi-Fi SSID</label><input name=ssid maxlength=32 required>"
    "<label>Wi-Fi password</label><input name=password type=password maxlength=63>"
    "<label>Collector host/IP</label><input name=collectorHost maxlength=63 required>"
    "<label>Collector UDP port</label><input name=collectorPort type=number value=5566>"
    "<label>OTA manifest URL (https://)</label><input name=otaManifestUrl maxlength=191>"
    "<label>OTA channel</label><input name=otaChannel value=stable maxlength=15>"
#ifndef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
    "<label>Admin token (min 16 chars)</label><input name=adminToken maxlength=48 required>"
    "<label>Device name</label><input name=deviceName maxlength=31>"
#endif
    "<label>Capture mode</label><select name=captureMode>"
    "<option value=0>controlled</option><option value=1>normal-traffic</option>"
    "<option value=2>passive</option></select>"
    "<label>Ping packets/sec</label><input name=pingPps type=number value=25>"
    "<button type=submit>Save &amp; reboot</button></form>"
    "<p>The device will reconnect in station mode after saving.</p></body></html>";

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Extracts and URL-decodes a single application/x-www-form-urlencoded field. Returns false if
// the key is absent. out is always NUL-terminated when true is returned.
bool formField(const char* body, const char* key, char* out, size_t cap) {
  const size_t keyLen = std::strlen(key);
  const char* p = body;
  while (p && *p) {
    const char* amp = std::strchr(p, '&');
    const char* eq = std::strchr(p, '=');
    const char* segEnd = amp ? amp : p + std::strlen(p);
    if (eq && eq < segEnd && static_cast<size_t>(eq - p) == keyLen &&
        std::strncmp(p, key, keyLen) == 0) {
      const char* v = eq + 1;
      size_t o = 0;
      while (v < segEnd && o < cap - 1) {
        char c = *v;
        if (c == '+') {
          c = ' ';
          ++v;
        } else if (c == '%' && v + 2 < segEnd + 1 && hexVal(v[1]) >= 0 && hexVal(v[2]) >= 0) {
          c = static_cast<char>(hexVal(v[1]) * 16 + hexVal(v[2]));
          v += 3;
        } else {
          ++v;
        }
        out[o++] = c;
      }
      out[o] = '\0';
      return true;
    }
    p = amp ? amp + 1 : nullptr;
  }
  return false;
}

esp_err_t rootGet(httpd_req_t* req) {
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, kSetupPage, HTTPD_RESP_USE_STRLEN);
}

void rebootTask(void*) {
  vTaskDelay(pdMS_TO_TICKS(1500));
  esp_restart();
}

esp_err_t savePost(httpd_req_t* req) {
  if (req->content_len >= kMaxBodyLen) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "form too large");
    return ESP_OK;
  }
  char body[kMaxBodyLen];
  int total = 0;
  while (total < static_cast<int>(req->content_len)) {
    int r = httpd_req_recv(req, body + total, req->content_len - total);
    if (r <= 0) {
      httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "recv failed");
      return ESP_OK;
    }
    total += r;
  }
  body[total] = '\0';

  DeviceConfig c{};  // start from defaults
  formField(body, "ssid", c.wifiSsid, sizeof(c.wifiSsid));
  formField(body, "password", c.wifiPassword, sizeof(c.wifiPassword));
  formField(body, "collectorHost", c.collectorHost, sizeof(c.collectorHost));
  formField(body, "otaManifestUrl", c.otaManifestUrl, sizeof(c.otaManifestUrl));
  formField(body, "otaChannel", c.otaChannel, sizeof(c.otaChannel));
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
  std::strncpy(c.adminToken, "disposable-experiment-token", sizeof(c.adminToken) - 1);
  std::strncpy(c.deviceName, "rf-sense-experiment", sizeof(c.deviceName) - 1);
#else
  formField(body, "adminToken", c.adminToken, sizeof(c.adminToken));
  formField(body, "deviceName", c.deviceName, sizeof(c.deviceName));
#endif

  char tmp[16];
  if (formField(body, "collectorPort", tmp, sizeof(tmp))) {
    c.collectorPort = static_cast<uint16_t>(atoi(tmp));
  }
  if (formField(body, "captureMode", tmp, sizeof(tmp))) {
    c.captureMode = static_cast<uint8_t>(atoi(tmp));
  }
  if (formField(body, "pingPps", tmp, sizeof(tmp))) {
    c.pingPps = static_cast<uint16_t>(atoi(tmp));
  }
  c.provisioned = true;

  esp_err_t err = ConfigStore::instance().save(c);
  if (err != ESP_OK) {
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_status(req, "400 Bad Request");
    httpd_resp_sendstr(req,
                       "<html><body><h1>Invalid settings</h1>"
                       "<p>Check SSID, password length (8-63), and "
                       "collector host. <a href=/>Back</a></p></body></html>");
    return ESP_OK;
  }

  ESP_LOGI(kTag, "provisioning saved; rebooting into station mode");
  httpd_resp_set_type(req, "text/html");
  httpd_resp_sendstr(req,
                     "<html><body><h1>Saved</h1><p>Rebooting and connecting to Wi-Fi. You can "
                     "close this page.</p></body></html>");
  xTaskCreate(rebootTask, "prov_reboot", 2048, nullptr, 5, nullptr);
  return ESP_OK;
}

}  // namespace

Provisioning& Provisioning::instance() {
  static Provisioning p;
  return p;
}

esp_err_t Provisioning::start(const std::string& apSsid, const std::string& apPassword) {
  esp_err_t err = WifiManager::instance().startSoftAp(apSsid, apPassword);
  if (err != ESP_OK) return err;

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.lru_purge_enable = true;
  httpd_handle_t handle = nullptr;
  err = httpd_start(&handle, &config);
  if (err != ESP_OK) return err;
  server_ = handle;

  httpd_uri_t root = {};
  root.uri = "/";
  root.method = HTTP_GET;
  root.handler = rootGet;
  httpd_register_uri_handler(handle, &root);

  httpd_uri_t save = {};
  save.uri = "/save";
  save.method = HTTP_POST;
  save.handler = savePost;
  httpd_register_uri_handler(handle, &save);

  ESP_LOGI(kTag, "SoftAP '%s' up; setup page at http://192.168.4.1", apSsid.c_str());
  return ESP_OK;
}

esp_err_t Provisioning::stop() {
  if (!server_) return ESP_OK;
  esp_err_t err = httpd_stop(static_cast<httpd_handle_t>(server_));
  server_ = nullptr;
  WifiManager::instance().stopSoftAp();
  return err;
}

}  // namespace rfsense
