// Minimal HTTP control plane (esp_http_server) exposing /api/v1/*. This is an operational
// API, not a dashboard: status/health/config reads plus a few mutating actions.
//
// Capture coordination lives in app_main; ControlApi calls into it through hooks so this
// component does not depend on csi_capture / ping_source / network_stream directly.
#pragma once

#include <functional>

#include "esp_err.h"

namespace rfsense {

struct ControlHooks {
  std::function<bool()> startCapture;  // returns true on success
  std::function<bool()> stopCapture;
  std::function<bool()> isCapturing;
};

class ControlApi {
 public:
  static ControlApi& instance();

  void setHooks(const ControlHooks& hooks) { hooks_ = hooks; }
  void configureIds(uint32_t deviceId, uint32_t bootId) {
    deviceId_ = deviceId;
    bootId_ = bootId;
  }

  esp_err_t start(uint16_t port = 80);
  esp_err_t stop();

  // Accessors used by the HTTP request handlers (defined in the .cpp).
  bool hooksStartCapture();
  bool hooksStopCapture();
  bool hooksIsCapturing() const;
  uint32_t deviceId() const { return deviceId_; }
  uint32_t bootId() const { return bootId_; }

 private:
  ControlApi() = default;

  void* server_ = nullptr;  // httpd_handle_t
  ControlHooks hooks_{};
  uint32_t deviceId_ = 0;
  uint32_t bootId_ = 0;
};

}  // namespace rfsense
