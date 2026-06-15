// HTTPS OTA orchestration. Manifest-first: download + validate a small JSON manifest, then
// (only on an explicit apply) stream the firmware into the inactive slot while hashing it,
// verify the SHA-256 against the manifest, switch the boot partition, and reboot.
//
// The application image is the ONLY thing OTA touches: never the bootloader, partition table,
// otadata, NVS, or phy_init. TLS is always enforced (embedded root CA or cert bundle); plain
// HTTP is refused unless the firmware was built with CONFIG_RF_SENSE_OTA_ALLOW_INSECURE_HTTP.
#pragma once

#include <atomic>
#include <functional>

#include "OtaManifest.h"
#include "esp_err.h"

namespace rfsense {

enum class OtaState {
  Idle,
  Checking,
  UpdateAvailable,
  Applying,
  ReadyToReboot,
  Failed,
};

struct OtaStatus {
  OtaState state = OtaState::Idle;
  bool updateAvailable = false;
  ManifestReject lastReject = ManifestReject::None;
  char availableVersion[kManifestVersionMax] = {0};
  char message[80] = {0};
};

class OtaManager {
 public:
  static OtaManager& instance();

  void configure(const char* currentVersion, uint32_t flashSizeBytes, uint32_t otaSlotSizeBytes);

  // Called before any firmware download so the app can stop pinging, disable CSI capture,
  // drain queued frames, and notify the collector that the device is going into maintenance.
  void setMaintenanceHook(std::function<void()> fn) { maintenanceHook_ = std::move(fn); }

  // Downloads + validates the manifest at url. On success stores it as the pending candidate
  // and reports whether it is a newer, acceptable image. Safe to call repeatedly; single-flight.
  bool check(const char* manifestUrl);

  // Applies the pending manifest: runs the maintenance hook, streams + hashes the firmware,
  // verifies SHA-256, switches boot partition, then reboots (does not return on success).
  // Returns false if no valid pending manifest, another OTA is in flight, or any step fails.
  bool apply();

  OtaStatus status() const;
  bool isBusy() const { return busy_.load(std::memory_order_relaxed); }

 private:
  OtaManager() = default;
  bool downloadManifest(const char* url, char* buf, size_t cap, size_t& outLen);
  void setMessage(OtaState state, const char* msg);

  ManifestContext context() const;

  mutable std::atomic<bool> busy_{false};
  OtaState state_ = OtaState::Idle;
  bool pendingValid_ = false;
  OtaManifest pending_{};
  ManifestReject lastReject_ = ManifestReject::None;
  char message_[80] = {0};

  char currentVersion_[kManifestVersionMax] = {0};
  uint32_t flashSizeBytes_ = 0;
  uint32_t otaSlotSizeBytes_ = 0;

  std::function<void()> maintenanceHook_;
};

}  // namespace rfsense
