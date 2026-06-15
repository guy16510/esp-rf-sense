// Owns the rollback lifecycle and the persistent boot/OTA counters mirrored into DeviceHealth.
//
// Flow after an OTA: the new app boots in PENDING_VERIFY. app_main runs startup diagnostics
// and, once healthy for a configurable window, calls confirmHealthy() -> the running app is
// marked valid and rollback is cancelled. If diagnostics fail (or a boot loop is detected),
// rollbackNow() reboots into the previous slot. A boot-loop counter in NVS catches apps that
// crash before they can self-report.
#pragma once

#include <cstdint>

#include "DeviceHealth.h"
#include "esp_err.h"

namespace rfsense {

class BootGuard {
 public:
  static BootGuard& instance();

  // Reads persistent counters from NVS, bumps bootCount + consecutiveFailedBoots (the latter
  // is cleared by confirmHealthy), and reports whether this boot is an unverified OTA trial.
  // Must run after nvs_flash_init().
  esp_err_t begin();

  // True if the running app partition is in PENDING_VERIFY (a freshly OTA'd image on trial).
  bool isPendingVerify() const { return pendingVerify_; }

  // True once consecutiveFailedBoots has crossed the configured threshold: the app keeps
  // rebooting before confirming health, so we should refuse risky work / force rollback.
  bool inBootLoop() const;

  // Marks the running app valid (cancels rollback) and clears consecutiveFailedBoots.
  esp_err_t confirmHealthy();

  // Marks the running app invalid and reboots into the previous slot. Does not return on
  // success. Used when post-OTA diagnostics fail.
  esp_err_t rollbackNow();

  // OTA bookkeeping (persisted). Called by OtaManager around an update attempt.
  void recordOtaAttempt();
  void recordOtaSuccess();
  void recordOtaFailure();

  PersistentStats stats() const { return stats_; }

 private:
  BootGuard() = default;
  esp_err_t persist();
  void mirrorToHealth();

  PersistentStats stats_{};
  bool pendingVerify_ = false;
  bool loaded_ = false;
};

}  // namespace rfsense
