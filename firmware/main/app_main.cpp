// Boot orchestration for the RF-Sense CSI receiver.
//
// Flow:
//   init NVS/event loop/netif -> BootGuard (boot counters + pending-verify) -> ConfigStore.
//   If unprovisioned: bring up SoftAP + setup page, then idle (provisioning reboots us).
//   If provisioned: connect station, init the CSI pipeline, control API, mDNS, then a
//   supervisor task confirms post-OTA health, auto-starts capture, and refreshes telemetry.
//
// Capture coordination and the OTA maintenance hook live here so individual components stay
// decoupled (no component depends on another that would form a cycle).
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>

#include "AppConfig.h"
#include "BootGuard.h"
#include "ConfigStore.h"
#include "ControlApi.h"
#include "CsiCapture.h"
#include "DeviceHealth.h"
#include "FrameQueue.h"
#include "MdnsService.h"
#include "NetworkStreamer.h"
#include "OtaManager.h"
#include "PingSource.h"
#include "Provisioning.h"
#include "WifiManager.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace rfsense {
namespace {
constexpr char kTag[] = "app_main";

// Default SoftAP password used during provisioning (WPA2 needs >= 8 chars). Operators can
// change it by re-flashing; it only guards the one-time setup window.
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
constexpr char kProvisioningApPassword[] = "";
#else
constexpr char kProvisioningApPassword[] = "rfsense-setup";
#endif

#ifdef CONFIG_RF_SENSE_OTA_VERIFY_PERIOD_S
constexpr int kVerifyPeriodS = CONFIG_RF_SENSE_OTA_VERIFY_PERIOD_S;
#else
constexpr int kVerifyPeriodS = 30;
#endif

uint32_t g_deviceId = 0;
uint32_t g_bootId = 0;

proto::CaptureMode toMode(uint8_t m) {
  switch (m) {
    case 1: return proto::CaptureMode::Normal;
    case 2: return proto::CaptureMode::Passive;
    default: return proto::CaptureMode::Controlled;
  }
}

std::string id4Lower() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char buf[8];
  std::snprintf(buf, sizeof(buf), "%02x%02x", mac[4], mac[5]);
  return buf;
}
std::string id4Upper() {
  std::string s = id4Lower();
  for (auto& c : s) c = static_cast<char>(::toupper(c));
  return s;
}

uint32_t deviceIdFromMac() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  return (static_cast<uint32_t>(mac[2]) << 24) | (static_cast<uint32_t>(mac[3]) << 16) |
         (static_cast<uint32_t>(mac[4]) << 8) | static_cast<uint32_t>(mac[5]);
}

std::string gatewayIp() {
  esp_netif_t* sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  esp_netif_ip_info_t ip;
  if (sta && esp_netif_get_ip_info(sta, &ip) == ESP_OK && ip.gw.addr != 0) {
    char buf[16];
    esp_ip4addr_ntoa(&ip.gw, buf, sizeof(buf));
    return buf;
  }
  return {};
}

// --- capture coordination (wired into ControlApi hooks) ---

bool captureStart() {
  if (CsiCapture::instance().isActive()) return true;
  const DeviceConfig c = ConfigStore::instance().get();
  const proto::CaptureMode mode = toMode(c.captureMode);

  NetworkStreamer::instance().setCaptureMode(mode);
  CsiCapture::instance().setCaptureMode(mode);

  if (!NetworkStreamer::instance().start()) {
    ESP_LOGE(kTag, "network streamer failed to start");
    return false;
  }
  if (CsiCapture::instance().start() != ESP_OK) {
    ESP_LOGE(kTag, "csi capture failed to start");
    NetworkStreamer::instance().stop();
    return false;
  }

  if (mode == proto::CaptureMode::Controlled) {
    const std::string gw = gatewayIp();
    if (gw.empty()) {
      ESP_LOGW(kTag, "no gateway IP yet; controlled ping deferred");
    } else {
      PingConfig pc;
      pc.targetIp = gw;
      pc.packetsPerSecond = c.pingPps ? c.pingPps : kDefaultPingPps;
      pc.payloadBytes = c.pingPayloadBytes ? c.pingPayloadBytes : kDefaultPingPayload;
      pc.timeoutMs = c.pingTimeoutMs;
      pc.warmupMs = c.pingWarmupMs;
      PingSource::instance().start(pc);
      ESP_LOGI(kTag, "controlled ping -> %s @ %u pps", gw.c_str(), pc.packetsPerSecond);
    }
  }
  ESP_LOGI(kTag, "capture started (mode=%d)", static_cast<int>(mode));
  return true;
}

bool captureStop() {
  PingSource::instance().stop();
  CsiCapture::instance().stop();
  NetworkStreamer::instance().stop();
  ESP_LOGI(kTag, "capture stopped");
  return true;
}

// OTA maintenance hook: stop perturbing the radio, drop queued frames, tell the collector.
void otaMaintenance() {
  PingSource::instance().stop();
  CsiCapture::instance().stop();
  FrameQueue::instance().drain();
  NetworkStreamer::instance().sendMaintenanceNotice();
  NetworkStreamer::instance().stop();
  ESP_LOGW(kTag, "entered OTA maintenance: capture halted, collector notified");
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

void confirmPostOtaHealth() {
  if (!BootGuard::instance().isPendingVerify()) return;
  ESP_LOGW(kTag, "running unverified OTA image; verifying for %ds", kVerifyPeriodS);
  bool healthy = true;
  for (int i = 0; i < kVerifyPeriodS; ++i) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    if (!WifiManager::instance().isConnected()) healthy = false;
    if (BootGuard::instance().inBootLoop()) {
      healthy = false;
      break;
    }
  }
  if (healthy && WifiManager::instance().isConnected()) {
    BootGuard::instance().confirmHealthy();
    ESP_LOGI(kTag, "post-OTA validation passed");
  } else {
    BootGuard::instance().rollbackNow();  // reboots; does not return on success
  }
}

void supervisorTask(void*) {
  // Block risky behavior until we know this image is trustworthy.
  confirmPostOtaHealth();

  captureStart();

  const DeviceConfig cfg = ConfigStore::instance().get();
  uint32_t elapsedS = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(2000));
    elapsedS += 2;

    DeviceHealth::instance().setRssi(WifiManager::instance().currentRssi());
    DeviceHealth::instance().setCsiQueued(FrameQueue::instance().queued());
    const OtaStatus ota = OtaManager::instance().status();
    MdnsService::instance().updateState(CsiCapture::instance().isActive(), otaStateText(ota.state));

    // Optional scheduled OTA check (off by default). Never auto-applies while capturing.
    if (cfg.otaScheduledEnabled && cfg.otaManifestUrl[0] != '\0' &&
        elapsedS >= cfg.otaScheduledIntervalS) {
      elapsedS = 0;
      if (!OtaManager::instance().isBusy()) {
        const bool available = OtaManager::instance().check(cfg.otaManifestUrl);
        if (available && cfg.otaAutoApply && !CsiCapture::instance().isActive()) {
          ESP_LOGW(kTag, "scheduled auto-apply: update available and device idle");
          OtaManager::instance().apply();
        }
      }
    }
  }
}

esp_err_t initNvs() {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  return err;
}

}  // namespace
}  // namespace rfsense

extern "C" void app_main() {
  using namespace rfsense;

  ESP_ERROR_CHECK(initNvs());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  ESP_ERROR_CHECK(esp_netif_init());

  ESP_ERROR_CHECK(BootGuard::instance().begin());
  ESP_ERROR_CHECK(ConfigStore::instance().init());

  g_deviceId = deviceIdFromMac();
  g_bootId = esp_random();
  const BuildInfo bi = buildInfo();
  ESP_LOGI(kTag, "rf-sense %s (%s) deviceId=%08lx bootId=%08lx", bi.version, bi.gitCommit,
           static_cast<unsigned long>(g_deviceId), static_cast<unsigned long>(g_bootId));
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
  ESP_LOGW(kTag, "DISPOSABLE EXPERIMENT BUILD for classic ESP32; not an S3 production image");
#endif

  ESP_ERROR_CHECK(WifiManager::instance().init());

  if (!ConfigStore::instance().isProvisioned()) {
#ifdef CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT
    DeviceConfig experiment{};
    std::strncpy(experiment.wifiSsid, "YOUR_WIFI_SSID", sizeof(experiment.wifiSsid) - 1);
    std::strncpy(experiment.wifiPassword, "YOUR_WIFI_PASSWORD",
                 sizeof(experiment.wifiPassword) - 1);
    std::strncpy(experiment.collectorHost, "192.168.1.100",
                 sizeof(experiment.collectorHost) - 1);
    std::strncpy(experiment.adminToken, "disposable-experiment-token",
                 sizeof(experiment.adminToken) - 1);
    std::strncpy(experiment.deviceName, "rf-sense-experiment",
                 sizeof(experiment.deviceName) - 1);
    experiment.collectorPort = 5566;
    experiment.provisioned = true;
    ESP_LOGW(kTag, "seeding disposable hard-coded Wi-Fi and collector configuration");
    ESP_ERROR_CHECK(ConfigStore::instance().save(experiment));
#else
    const std::string apSsid = "RF-Sense-" + id4Upper();
    ESP_LOGW(kTag, "device not provisioned; starting SoftAP '%s'", apSsid.c_str());
    ESP_ERROR_CHECK(Provisioning::instance().start(apSsid, kProvisioningApPassword));
    return;  // provisioning saves config and reboots into station mode
#endif
  }

  const DeviceConfig cfg = ConfigStore::instance().get();

  if (!FrameQueue::instance().init()) {
    ESP_LOGE(kTag, "frame queue init failed");
  }

  CsiCapture::instance().configureIds(g_deviceId, g_bootId);
  CsiCapture::instance().setCaptureMode(toMode(cfg.captureMode));
  CsiCapture::instance().setPingSeqSource([] { return PingSource::instance().lastSeq(); });

  NetworkStreamer::instance().configure(g_deviceId, g_bootId);
  NetworkStreamer::instance().setTarget(cfg.collectorHost, cfg.collectorPort);

  OtaManager::instance().configure(bi.version, kFlashSizeBytes, kOtaSlotSizeBytes);
  OtaManager::instance().setMaintenanceHook(otaMaintenance);

  ControlApi::instance().configureIds(g_deviceId, g_bootId);
  ControlApi::instance().setHooks({captureStart, captureStop,
                                   [] { return CsiCapture::instance().isActive(); }});

  WifiManager::instance().startStation(cfg.wifiSsid, cfg.wifiPassword);
  WifiManager::instance().waitForIp(15000);

  ESP_ERROR_CHECK(ControlApi::instance().start(kDefaultControlPort));

  const std::string host = "rf-sense-" + id4Lower();
  const std::string instance = "RF-Sense " + id4Upper();
  MdnsService::instance().start(host, instance, bi.version, g_deviceId, bi.hardwareTarget);

  xTaskCreate(supervisorTask, "supervisor", 4096, nullptr, kPrioControl, nullptr);
}
