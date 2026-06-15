# Known limitations

This lab is designed to make *honest* claims. That requires being explicit about what it cannot
do and what numbers it cannot produce from this repository alone. Read this before presenting any
result.

## Physical and operational limits

- **One physical bootstrap flash is unavoidable.** A blank/erased board must be flashed once over
  USB ([initial-bootstrap.md](initial-bootstrap.md)). Only after that do updates go over OTA.
- **Bootloader / partition-table changes need another physical flash.** They are never OTA-able by
  design. Routine app updates never need a cable.
- **One ESP32-S3 + one existing router.** A single TX/RX link. No antenna array, no multiple
  vantage points.

## Sensing limits (be conservative with claims)

- **Coarse spatial resolution.** One RF link gives very limited spatial information. Expect, at
  best, presence and coarse position/zone — not fine localization or reliable people-counting.
- **ESP32-S3 CSI granularity.** CSI resolution/format on the ESP32-S3 constrains what is
  recoverable; it is not a calibrated vector network analyzer.
- **CSI phase needs sanitization.** Raw phase carries hardware-induced offsets/slopes; the
  analysis removes a per-frame linear ramp, but residual phase artifacts limit phase-based
  features.
- **Stationary presence is the hard case.** Detecting motion is far easier than distinguishing a
  perfectly still person from an empty room.
- **Body-size signal is a hypothesis, not a capability.** Any height/weight signal must be
  **rejected** if it fails leave-one-person-out generalization. Body measurements are optional,
  consent-gated, and never the basis of a claim by default.

## Evaluation limits

- **Single-room results must not be presented as general accuracy.** A model that does well
  within one room/day is likely memorizing that environment. Only leave-one-{person,position,day}-out
  performance, beating the train-derived majority baseline, supports a generalization claim.
- **Window leakage is the classic trap, and is guarded.** Adjacent windows of one recording share
  provenance; the splitter refuses to put them on both sides of a split. Do not bypass it.
- **Class balance and diversity matter.** Conclusions from few subjects, one position, or one day
  are not generalization evidence regardless of accuracy.

## Numbers this repo does NOT produce on its own

The authoring repository does not build firmware or run hardware. The following must come from CI
and/or your hardware, and are **never hand-entered**:

- **Real binary size and OTA-slot utilization** — produced by `firmware-ci` (`size_check.py`),
  which is the source of truth and hard-fails above 85% of a slot.
- **Sustained CSI capture rate** — depends on channel, traffic, ping rate, and environment;
  measure on hardware.
- **Endurance** — 24 h capture, 24 h streaming, repeated reconnects, memory/stack stability, and
  the absence of a recurring heap decline must be observed on hardware over real time.
- **OTA cycle robustness** — ≥20 sequential OTA cycles between two known-good versions, plus the
  failure-mode behaviors (interrupted download, power loss at each phase, TLS failure, failed
  startup validation, auto rollback) must be exercised on hardware or a QEMU harness. The
  *pure-logic* parts (manifest accept/reject, semver, size/SHA checks, state transitions,
  capture↔OTA lock, boot-loop threshold) are unit-tested on the host in CI.

## Scope exclusions (not bugs — deliberate non-goals)

Presence evidence comes **only** from how a body perturbs the RF channel. The system never uses,
and will not add:

- device counting, Wi-Fi **probe-request** sniffing, BLE scanning, or **MAC** tracking;
- phone/person identification, cameras, or face recognition;
- cloud analytics or dashboards;
- LVGL/displays/touch, LED animations, QR codes, or any product-style features;
- bootloader/partition-table OTA, or irreversible eFuse configuration (secure boot / flash
  encryption / anti-rollback) during research.

These are listed so reviewers can confirm the privacy stance: a person is detected by their effect
on radio waves, not by anything they carry or transmit.
