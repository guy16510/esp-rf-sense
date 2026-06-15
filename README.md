# esp32-rf-sense-lab

A scientific evaluation harness for **device-free human sensing** using a single
**ESP32-S3** as a Wi-Fi **CSI (Channel State Information) receiver** and an existing
2.4 GHz router as the transmitter. The device harvests CSI from router replies (triggered
by controlled ICMP pings), streams the raw I/Q off-device over UDP to a LAN collector, and
the data is analyzed offline with classical signal processing and machine learning.

The research question: **how accurately can one RF link detect and characterize a person who
carries no transmitter** — empty vs. occupied, moving vs. stationary, coarse position — and
crucially, **does any signal generalize across people, positions, and days**, or is it just
overfitting to one room on one afternoon?

> This is a measurement and evaluation lab, not a product. It deliberately avoids any form of
> device counting, probe-request sniffing, BLE scanning, or MAC tracking — presence evidence
> comes only from how a body perturbs the RF channel. See
> [docs/known-limitations.md](docs/known-limitations.md).

## How it is meant to be operated

The device is **normally not USB-connected**. The USB cable is used exactly once:

1. **Bootstrap flash (USB, once)** — flash bootloader + partition table + otadata + initial app.
   See [docs/initial-bootstrap.md](docs/initial-bootstrap.md).
2. **Wi-Fi provisioning (headless)** — the unprovisioned device raises a `RF-Sense-XXXX` SoftAP;
   a setup page captures Wi-Fi, collector, OTA, and admin-token settings. See
   [docs/wifi-provisioning.md](docs/wifi-provisioning.md).
3. **Run experiments** — the collector and experiment runner drive capture remotely over the
   LAN. See [docs/experiment-protocol.md](docs/experiment-protocol.md).
4. **Update over the air** — every later firmware update is **HTTPS OTA of the app slot**, with
   automatic rollback. No USB. See [docs/ota-deployment.md](docs/ota-deployment.md) and
   [docs/ota-recovery.md](docs/ota-recovery.md).

Changing the bootloader or partition table is the *only* thing that needs another physical
flash; ordinary app updates never do.

## Repository layout

```
firmware/            ESP-IDF v5.3.2 application (ESP32-S3, C++ components)
  components/        config_store, wifi_manager, provisioning, csi_capture, ping_source,
                     frame_pipeline, network_stream, protocol, control_api, ota_manager,
                     device_health, mdns_service
  tools/             build_bootstrap_bundle.py, gen_manifest.py, size_check.py
  test/host/         host-compiled unit tests (no hardware; run in CI)
tools/
  collector/         (TS) UDP CSI receiver: validate, record JSONL+binary+CSV, loss/reboot stats
  ota-server/        (TS) HTTPS manifest + firmware server with startup validation
  cli/               (TS) device:discover / device:ota:check / device:ota:apply / device:status
  experiments/       (TS) remote experiment runner + metadata schema + group templates
  analysis/          (Python) raw parser, DSP, features, classical ML, group-aware CV
docs/                architecture + protocol + operating + security + limitations
.github/workflows/   firmware-ci, tools-ci, release, deploy-ota
```

## Toolchain (all pinned)

| Component | Version | Pin location |
|---|---|---|
| ESP-IDF | v5.3.2 | [.idf-version](.idf-version), [firmware/dependencies.lock](firmware/dependencies.lock), CI |
| Node | 22.x LTS | [.nvmrc](.nvmrc), CI |
| Python | 3.12 | [tools/analysis/pyproject.toml](tools/analysis/pyproject.toml), CI |
| Target | ESP32-S3-WROOM-1-N4R8 (4 MB flash / 8 MB PSRAM) | [firmware/sdkconfig.defaults](firmware/sdkconfig.defaults) |

## Running this (agent runbook)

This section is written so an automated agent can execute it top to bottom. Each task lists its
prerequisites, the exact commands, and the **pass signal** to check. Tasks A–C need **no hardware
and no ESP-IDF** and should be run first; tasks D–E require an ESP-IDF build machine and the
physical board and must **not** be attempted on a machine without them.

### Decision tree

```
Need ESP-IDF or the ESP32-S3 board?
├─ NO  → run A (Node tools), B (Python analysis), C (host C++ tests). This is the full
│         no-hardware verification: lint, typecheck, unit tests, wire-format round-trip, ML CV.
└─ YES → A–C must pass first, then D (build firmware on an ESP-IDF v5.3.2 machine) and
          E (flash + provision + capture on hardware). If ESP-IDF/board are absent, STOP after C
          and report — do not install ESP-IDF or fabricate build/size numbers.
```

> **Do not** run `idf.py`, flash scripts, or `cmake` for firmware if the toolchain/board is
> absent — they will fail. CI (`firmware-ci`) is the source of truth for firmware build, binary
> size, and OTA-slot utilization; those numbers are never hand-entered.

### Prerequisites check (read-only, safe to run anywhere)

```bash
node --version      # expect v22.x (matches .nvmrc)
python3 --version   # expect 3.12.x
cmake --version     # task C only; if absent, use the g++ fallback shown in C
idf.py --version    # tasks D/E only; if "command not found", skip D/E and stop after C
```

### A. Node host tools — no hardware

```bash
npm ci
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```
**Pass signal:** all five commands exit 0; vitest reports all test files passing. This covers the
collector, ota-server, cli, and experiments workspaces and the TS↔firmware wire-format tests.

### B. Python analysis — no hardware

```bash
cd tools/analysis
pip install -e ".[dev]"
ruff check . && pytest -q
cd ../..
```
**Pass signal:** `ruff` reports no errors and `pytest` exits 0 (parser / DSP / filters / features /
splits / models, including the leave-one-person-out separability test). `sklearn`-dependent tests
self-skip if scikit-learn is unavailable — install the `dev` extra to run them.

### C. Firmware pure-logic unit tests — no hardware, no ESP-IDF

Preferred (if `cmake` is present):
```bash
cmake -S firmware/test/host -B build/host-test && cmake --build build/host-test
ctest --test-dir build/host-test --output-on-failure
```
Fallback (no `cmake`, just a C++17 compiler) — compiles and runs the same four tests:
```bash
B=build/host-test && mkdir -p "$B"
INC="-Ifirmware/test/host -Ifirmware/components/protocol/include -Ifirmware/components/config_store/include -Ifirmware/components/ota_manager/include -Ifirmware/components/frame_pipeline/include"
g++ -std=c++17 -Wall -Wextra -Werror $INC firmware/test/host/test_protocol.cpp     firmware/components/protocol/Protocol.cpp                                          -o "$B/test_protocol"     && "$B/test_protocol"
g++ -std=c++17 -Wall -Wextra -Werror $INC firmware/test/host/test_config_codec.cpp firmware/components/protocol/Protocol.cpp firmware/components/config_store/ConfigCodec.cpp -o "$B/test_config_codec" && "$B/test_config_codec"
g++ -std=c++17 -Wall -Wextra -Werror $INC firmware/test/host/test_ota_manifest.cpp firmware/components/ota_manager/OtaManifest.cpp                                   -o "$B/test_ota_manifest" && "$B/test_ota_manifest"
g++ -std=c++17 -Wall -Wextra -Werror $INC firmware/test/host/test_frame_ring.cpp                                                                                     -o "$B/test_frame_ring"   && "$B/test_frame_ring"
```
**Pass signal:** each test prints `N checks, 0 failures` and exits 0 (ctest reports `100% passed`).

### D. Build firmware — REQUIRES ESP-IDF v5.3.2 (build machine or CI only)

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
python tools/size_check.py --app build/rf-sense.bin          # fails if app > 85% of a slot
python tools/build_bootstrap_bundle.py --build-dir build --out ../dist/bootstrap
cd ..
```
**Pass signal:** `idf.py build` succeeds, `size_check.py` exits 0, and `dist/bootstrap/` contains
`rf-sense-bootstrap-combined.bin` + `SHA256SUMS`. If `idf.py` is not installed, **skip this task**.

### E. Hardware bring-up — REQUIRES the ESP32-S3 board + a router (one-time, manual)

1. **Flash once over USB** (from `dist/bootstrap/`): `PORT=/dev/ttyUSB0 ./flash-bootstrap.sh`
   — see [docs/initial-bootstrap.md](docs/initial-bootstrap.md).
2. **Provision over Wi-Fi**: join the `RF-Sense-XXXX` AP, open `http://192.168.4.1`, set SSID,
   collector host/port, OTA URL, admin token — see [docs/wifi-provisioning.md](docs/wifi-provisioning.md).
3. **Start the collector** and run an experiment session:
   ```bash
   export RF_SENSE_DEVICE=rf-sense-a1b2.local RF_SENSE_TOKEN=...
   npm run device:status
   npm run collector:start -- --out ./recordings/run1            # in one shell
   npm run experiment:start -- --template stationary --experiment-id room-A \
     --room "room A" --day "$(date +%F)" --subject-id p3 --position deskA --duration 120
   ```
4. **Analyze** the recordings: `cd tools/analysis && rfsense-evaluate --data ../../recordings --group person`.
5. **Watch a live view** (presence / coarse zone): `rfsense-live --udp-port 5566` (or
   `--replay <run>.csi.bin` with no hardware), then open `http://127.0.0.1:8080/`. Optionally train
   a display model first with `rfsense-train`. One RF link gives a coarse estimate, not coordinates
   — see [docs/live-view.md](docs/live-view.md).
6. **Update later via OTA** (no USB): `npm run device:ota:check` then `npm run device:ota:apply`
   — see [docs/ota-deployment.md](docs/ota-deployment.md).

### What "success" means without hardware

If A, B, and C all pass, the entire host stack, the cross-language wire-format round-trip
(firmware C++ ↔ TS collector ↔ Python parser), and the group-aware ML evaluation are verified.
Real CSI data, binary size, and endurance/OTA-cycle numbers require tasks D–E or CI.

## CI workflows

| Workflow | Trigger | Does |
|---|---|---|
| [firmware-ci](.github/workflows/firmware-ci.yml) | push/PR | host tests + build firmware + size budget + bootstrap/manifest artifacts |
| [tools-ci](.github/workflows/tools-ci.yml) | push/PR | Node lint/typecheck/test/build + Python ruff/pytest |
| [release](.github/workflows/release.yml) | `v*.*.*` tag | rebuild from tag → release `.bin` + bootstrap bundle + stable manifest + SHA256SUMS |
| [deploy-ota](.github/workflows/deploy-ota.yml) | manual | promote an existing release to the stable OTA server (never rebuilds) |

## Key design points

- **Raw CSI is never altered** by the firmware or collector — see
  [docs/csi-protocol.md](docs/csi-protocol.md).
- **The CSI callback does the minimum** (copy into a bounded static pool, bump counters);
  encoding, batching, and UDP TX run on separate tasks. See [docs/architecture.md](docs/architecture.md).
- **OTA is manifest-first, SHA-256-verified, app-slot-only, with rollback** — see
  [docs/ota-deployment.md](docs/ota-deployment.md).
- **Security posture is honest about what is and isn't enabled** (no secure boot / flash
  encryption during research) — see [docs/security-decisions.md](docs/security-decisions.md).

## License

MIT — see [LICENSE](LICENSE).
