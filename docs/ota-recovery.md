# OTA recovery and rollback

OTA can fail in many ways — a bad image, a crash on first boot, a power loss mid-write, a TLS
error. The design goal is that **no single failed update can brick a headless device**. This
document describes the safety net so you know what the device will do on its own and when you
must intervene physically.

## The two-slot + rollback model

There are always two app slots (`ota_0`, `ota_1`). An update writes the **inactive** one and
only switches the boot selector after a full SHA-256 verify. The previously-running, known-good
image stays intact in the other slot. ESP-IDF application rollback is enabled
(`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`), so a freshly-booted OTA image starts in
`PENDING_VERIFY` and must *prove* itself before it is marked valid.

`BootGuard` (`firmware/components/ota_manager`) owns this lifecycle and the persistent boot/OTA
counters mirrored into `DeviceHealth`.

## Post-OTA verification window

After an OTA reboot the new image runs startup diagnostics, then must stay healthy for a
configurable window before it is committed:

- **Verify period:** `CONFIG_RF_SENSE_OTA_VERIFY_PERIOD_S`, default **30 s** (range 5–600).
- **Startup diagnostics** that must pass: Wi-Fi connects, NVS opens, CSI init succeeds, the
  control API responds, and no boot-loop marker is set.
- On success: `confirmHealthy()` calls `esp_ota_mark_app_valid_cancel_rollback()`, clears the
  consecutive-failure counter, and the image becomes permanent.
- On diagnostic failure: `rollbackNow()` marks the image invalid and reboots into the previous
  slot.

## Boot-loop protection

Some failures crash the app *before* it can self-report. A persistent counter in NVS
(`consecutiveFailedBoots`) is bumped on every boot and only cleared by `confirmHealthy()`. Once
it crosses `CONFIG_RF_SENSE_BOOTLOOP_THRESHOLD` (default **3**), the device treats the running
image as bad: it refuses risky work and rolls back to the previous slot. This catches an image
that resets repeatedly without ever reaching the healthy state.

## Failure modes and what happens

| Failure | Outcome |
|---|---|
| Manifest rejected (wrong target, not newer, oversized, …) | update never starts; running image untouched |
| TLS handshake fails | update aborts; running image untouched |
| Download interrupted / truncated | SHA-256 mismatch → boot partition never switched |
| SHA-256 mismatch | inactive slot not made bootable; stays on current image |
| Power loss **before** the boot switch | otadata still points at the old image; boots as before |
| Power loss **after** the switch, image healthy | new image boots and verifies normally |
| New image fails startup diagnostics | automatic rollback to previous slot |
| New image boot-loops (crashes early) | boot-loop threshold → automatic rollback |
| Collector unavailable during/after OTA | does not block OTA; capture resumes when healthy |
| Repeated apply request while one is running | second request refused (single-flight lock) |

## Operator playbook

1. **Watch the state.** `npm run device:status` (or `GET /api/v1/status`) shows the `ota` state
   and, from health, `bootCount`, `consecutiveFailedBoots`, and OTA attempt/success/failure
   counts. After an apply, expect a brief gap (the `maintenance` flag), a reboot, then a return
   to healthy within the verify window.
2. **If it rolled back automatically**, the device comes back on the previous version — confirm
   with `status`. Investigate the bad image before re-publishing; do not just retry the same
   build.
3. **If the device is reachable but stuck `failed`**, you can re-check/apply a corrected
   manifest. A healthy image in either slot means OTA is still your recovery path — no cable
   needed.

## When OTA cannot save you (physical recovery)

OTA and rollback only help while at least one slot holds a bootable, reachable image. You must
fall back to a **USB bootstrap flash** ([initial-bootstrap.md](initial-bootstrap.md)) when:

- both slots are unbootable (e.g. a bad image was somehow committed and the other slot was never
  valid), or
- the device cannot join Wi-Fi at all and so cannot be reached for an OTA, or
- you changed the bootloader or partition table (never OTA-able by design).

Read out the coredump partition first if you are diagnosing a crash — it is preserved across the
rollback and survives an app-only reflash that does not erase it.

## Validating the safety net

The pure-logic parts (manifest accept/reject ordering, semver comparison, image-size and SHA
checks, OTA/rollback state transitions, boot-loop threshold, capture↔OTA lock) are unit-tested
on the host in CI. The end-to-end behaviors in the table above — interrupted download, power
loss at each phase, TLS failure, ≥20 sequential OTA cycles between two known-good versions —
must be exercised on real hardware or a QEMU harness; see [known-limitations.md](known-limitations.md).
