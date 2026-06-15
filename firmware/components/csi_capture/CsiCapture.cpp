#include "CsiCapture.h"

#include <cstring>

#include "DeviceHealth.h"
#include "FrameQueue.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "csi_capture";

uint8_t mapPhyMode(const wifi_pkt_rx_ctrl_t& rx) {
  // sig_mode: 0 = non-HT (11b/g), 1 = HT (11n). cwb: 0 = 20 MHz, 1 = 40 MHz.
  if (rx.sig_mode == 1) {
    return rx.cwb == 1 ? 3 : 2;  // 3 = HT40, 2 = HT20
  }
  return rx.rate <= 3 ? 0 : 1;  // crude 11b vs 11g split by rate index
}
}  // namespace

CsiCapture& CsiCapture::instance() {
  static CsiCapture c;
  return c;
}

void CsiCapture::configureIds(uint32_t deviceId, uint32_t bootId) {
  deviceId_ = deviceId;
  bootId_ = bootId;
}

void CsiCapture::setCaptureMode(proto::CaptureMode mode) {
  mode_.store(mode, std::memory_order_relaxed);
}

uint16_t CsiCapture::linkIdForMac(const uint8_t mac[6]) {
  return static_cast<uint16_t>(proto::crc32(mac, 6) & 0xFFFFu);
}

void CsiCapture::rxTrampoline(void* ctx, wifi_csi_info_t* info) {
  static_cast<CsiCapture*>(ctx)->onCsi(info);
}

// Hot path: keep this short and allocation/log free.
void CsiCapture::onCsi(wifi_csi_info_t* info) {
  if (info == nullptr || info->buf == nullptr || info->len <= 0) {
    return;
  }
  const wifi_pkt_rx_ctrl_t& rx = info->rx_ctrl;

  proto::FrameHeader h;
  h.frameSeq = frameSeq_.fetch_add(1, std::memory_order_relaxed);
  h.timestampUs = static_cast<uint64_t>(esp_timer_get_time());
  h.pingSeq = (mode_.load(std::memory_order_relaxed) == proto::CaptureMode::Controlled &&
               pingSeqSource_)
                  ? pingSeqSource_()
                  : proto::kPingSeqNone;
  h.rssi = static_cast<int8_t>(rx.rssi);
  h.noiseFloor = static_cast<int8_t>(rx.noise_floor);
  h.channel = static_cast<uint8_t>(rx.channel);
  h.secondaryChannel = static_cast<uint8_t>(rx.secondary_channel);
  h.bandwidth = static_cast<uint8_t>(rx.cwb);
  h.phyMode = mapPhyMode(rx);
  h.rate = static_cast<uint8_t>(rx.rate);
  h.firstWordInvalid = info->first_word_invalid ? 1 : 0;
  h.linkId = linkIdForMac(info->mac);
  h.csiLen = static_cast<uint16_t>(info->len);

  FrameQueue& q = FrameQueue::instance();
  if (q.pushFromCapture(h, reinterpret_cast<const uint8_t*>(info->buf),
                        static_cast<uint16_t>(info->len))) {
    DeviceHealth::instance().incCsiCaptured();
  } else {
    DeviceHealth::instance().incCsiQueueDrops();
  }
  DeviceHealth::instance().setCsiQueued(q.queued());
}

esp_err_t CsiCapture::start() {
  wifi_csi_config_t cfg{};
  cfg.lltf_en = true;
  cfg.htltf_en = true;
  cfg.stbc_htltf2_en = true;
  cfg.ltf_merge_en = true;
  cfg.channel_filter_en = false;  // keep raw; selection happens off-device by link id
  cfg.manu_scale = false;
  cfg.shift = false;

  esp_err_t err = esp_wifi_set_csi_config(&cfg);
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "set_csi_config failed: %s", esp_err_to_name(err));
    return err;
  }
  err = esp_wifi_set_csi_rx_cb(&CsiCapture::rxTrampoline, this);
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "set_csi_rx_cb failed: %s", esp_err_to_name(err));
    return err;
  }
  err = esp_wifi_set_csi(true);
  if (err != ESP_OK) {
    ESP_LOGE(kTag, "enable csi failed: %s", esp_err_to_name(err));
    return err;
  }
  active_.store(true, std::memory_order_relaxed);
  ESP_LOGI(kTag, "CSI capture started (mode=%d)",
           static_cast<int>(mode_.load(std::memory_order_relaxed)));
  return ESP_OK;
}

esp_err_t CsiCapture::stop() {
  esp_err_t err = esp_wifi_set_csi(false);
  active_.store(false, std::memory_order_relaxed);
  ESP_LOGI(kTag, "CSI capture stopped");
  return err;
}

}  // namespace rfsense
