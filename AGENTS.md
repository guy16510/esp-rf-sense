# Agent instructions

**To build, test, or run this project, follow the runbook in [README.md](README.md) →
"Running this (agent runbook)".** It has a decision tree, exact commands, and a pass signal for
each task. Start there; this file only carries the rules that aren't obvious from a single file.

## Hard constraints

- **No hardware / no ESP-IDF here.** Run README tasks **A** (Node tools), **B** (Python analysis),
  and **C** (host C++ tests) — they need neither. Attempt tasks **D** (firmware build) and **E**
  (flashing/capture) **only** if `idf.py --version` works and the ESP32-S3 board is present.
- **Use only ESP-IDF v5.3.2 and never fabricate build outputs.** If ESP-IDF is absent and firmware
  work is requested, it may be installed locally at the pinned version. Real binary size, OTA-slot
  utilization, and endurance/OTA-cycle numbers come only from CI (`firmware-ci`) or a real build.
- **`cmake` may be absent.** Task C in the README has a `g++`-only fallback that builds and runs
  the same four host tests.

## Wire format is a three-way contract

The binary CSI protocol is implemented three times and they must stay byte-for-byte in sync.
[docs/csi-protocol.md](docs/csi-protocol.md) is the single source of truth. If you change it:

1. bump `protocolVersion`,
2. update `firmware/components/protocol/`, `tools/collector/src/protocol.ts`, and
   `tools/analysis/rfsense_analysis/protocol.py` together,
3. update the OTA manifest fields in lockstep across `gen_manifest.py`,
   `firmware/components/ota_manager/include/OtaManifest.h`, and `tools/ota-server/src/manifest.ts`.

## Project guardrails (non-negotiable scope)

- Presence is detected **only** from how a body perturbs the RF channel. Never add device
  counting, probe-request sniffing, BLE scanning, MAC tracking, cameras, or person ID.
- Analysis must use **leave-one-{person,position,day}-out** CV and must never split windows of one
  recording across train/test. No deep learning at this stage. See
  [docs/known-limitations.md](docs/known-limitations.md).
- OTA updates the **app slot only** — never bootloader, partition table, otadata, NVS, or PHY.

## Conventions

- Toolchain is pinned: Node 22 (`.nvmrc`), Python 3.12, ESP-IDF v5.3.2 (`.idf-version`). Don't bump.
- TS: run `npm run format:check && npm run lint && npm run typecheck && npm test` before claiming
  done. Python: `ruff check . && pytest -q` in `tools/analysis`.
- Don't touch git unless asked.
