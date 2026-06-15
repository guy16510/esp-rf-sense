#include "PingSource.h"

#include "DeviceHealth.h"
#include "esp_log.h"
#include "lwip/inet.h"
#include "lwip/ip_addr.h"
#include "ping/ping_sock.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "ping_source";
}

PingSource& PingSource::instance() {
  static PingSource p;
  return p;
}

void PingSource::onSuccess(void* hdl, void* /*args*/) {
  uint16_t seqno = 0;
  esp_ping_get_profile(hdl, ESP_PING_PROF_SEQNO, &seqno, sizeof(seqno));
  PingSource& self = instance();
  self.lastSeq_.store(seqno, std::memory_order_relaxed);
  DeviceHealth::instance().incPingRequests();
  DeviceHealth::instance().incPingReplies();
}

void PingSource::onTimeout(void* hdl, void* /*args*/) {
  uint16_t seqno = 0;
  esp_ping_get_profile(hdl, ESP_PING_PROF_SEQNO, &seqno, sizeof(seqno));
  instance().lastSeq_.store(seqno, std::memory_order_relaxed);
  DeviceHealth::instance().incPingRequests();  // request sent, no reply
}

void PingSource::onEnd(void* /*hdl*/, void* /*args*/) {}

esp_err_t PingSource::start(const PingConfig& cfg) {
  if (active_.load(std::memory_order_relaxed)) {
    return ESP_OK;
  }
  if (cfg.targetIp.empty() || cfg.packetsPerSecond == 0 || cfg.packetsPerSecond > 200) {
    return ESP_ERR_INVALID_ARG;
  }

  ip_addr_t target{};
  if (!ipaddr_aton(cfg.targetIp.c_str(), &target)) {
    ESP_LOGE(kTag, "invalid target IP '%s'", cfg.targetIp.c_str());
    return ESP_ERR_INVALID_ARG;
  }

  esp_ping_config_t pc = ESP_PING_DEFAULT_CONFIG();
  pc.target_addr = target;
  pc.count = ESP_PING_COUNT_INFINITE;
  pc.interval_ms = 1000u / cfg.packetsPerSecond;
  if (pc.interval_ms == 0) pc.interval_ms = 1;
  pc.data_size = cfg.payloadBytes;
  pc.timeout_ms = cfg.timeoutMs ? cfg.timeoutMs : 500;

  esp_ping_callbacks_t cbs{};
  cbs.on_ping_success = &PingSource::onSuccess;
  cbs.on_ping_timeout = &PingSource::onTimeout;
  cbs.on_ping_end = &PingSource::onEnd;
  cbs.cb_args = this;

  esp_ping_handle_t handle = nullptr;
  esp_err_t err = esp_ping_new_session(&pc, &cbs, &handle);
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "new_session failed: %s", esp_err_to_name(err));
    return err;
  }
  err = esp_ping_start(handle);
  if (err != ESP_OK) {
    esp_ping_delete_session(handle);
    return err;
  }
  session_ = handle;
  active_.store(true, std::memory_order_relaxed);
  ESP_LOGI(kTag, "ping started: %s @ %u pps, %u-byte payload", cfg.targetIp.c_str(),
           cfg.packetsPerSecond, cfg.payloadBytes);
  return ESP_OK;
}

esp_err_t PingSource::stop() {
  if (!active_.load(std::memory_order_relaxed) || session_ == nullptr) {
    return ESP_OK;
  }
  auto handle = static_cast<esp_ping_handle_t>(session_);
  esp_ping_stop(handle);
  esp_ping_delete_session(handle);
  session_ = nullptr;
  active_.store(false, std::memory_order_relaxed);
  ESP_LOGI(kTag, "ping stopped");
  return ESP_OK;
}

}  // namespace rfsense
