# Architecture

The system has three tiers: the **device** (ESP32-S3 firmware), the **LAN tools** (collector,
OTA server, CLI, experiment runner), and **offline analysis** (Python). The router is an
unmodified existing access point — we never flash or configure it; we only elicit replies
from it.

```
        ┌──────────────────────────────────────────────────────────┐
        │ ESP32-S3 (CSI receiver)                                    │
        │                                                            │
   RF   │  Wi-Fi RX ──► csi_capture (ISR-context callback)           │
  ◄─────┤                  │  copy metadata + raw CSI into a         │
 router │                  ▼  bounded static pool slot; bump drops   │
        │            frame_pipeline (FrameQueue + FrameBatch pool)   │
        │                  │                                         │
        │       ┌──────────┴──────────┐                             │
        │  encode task            ping_source (controlled ICMP)     │
        │   build datagram             │ pings router → replies     │
        │       │                      ▼   produce CSI to capture   │
        │  network_stream (UDP) ──────────────────────────────────► │ collector (LAN)
        │  control_api (HTTP :80)  ota_manager (HTTPS OTA)           │
        │  device_health  mdns_service  config_store(NVS)           │
        └──────────────────────────────────────────────────────────┘
```

## Why CSI from a router we don't control

A person's body absorbs, reflects, and scatters 2.4 GHz energy. Each received Wi-Fi frame
carries a channel estimate (CSI) — per-subcarrier amplitude and phase — that changes as the
multipath environment changes, i.e. as a body moves through it. We need a steady stream of
frames *from a known peer* to sample that channel. In **controlled mode** we send ICMP echo
requests to the router at a fixed rate; each echo reply is a received frame with a CSI
estimate, tagged with the originating ping sequence so analysis can align cause and effect.
**Normal-traffic** and **passive** modes harvest CSI from whatever frames arrive, with less
timing control.

## The capture hot path (and what must never happen on it)

ESP-IDF delivers CSI in a callback that runs in Wi-Fi task context. The rule, enforced in
`csi_capture`:

- **Allowed:** copy the metadata we need + the raw CSI bytes into a **statically allocated,
  bounded** pool slot; increment an explicit drop counter when the pool is full.
- **Forbidden on the callback:** heap allocation, logging, JSON, filtering/DSP, HTTP, OTA,
  or any blocking call.

Everything expensive happens downstream on dedicated FreeRTOS tasks that read the queue:

| Task | Priority (`AppConfig.h`) | Role |
|---|---|---|
| encode | `kPrioEncode = 6` | drain the frame pool, serialize datagrams |
| network | `kPrioNetwork = 5` | send datagrams over UDP (never blocks the pipeline) |
| ping | `kPrioPing = 4` | controlled ping generation |
| control | `kPrioControl = 4` | HTTP control API |

Backpressure is explicit: if the pool or batch queue is full, frames are **dropped and
counted** rather than blocking capture or growing memory without bound. Drop counters are
surfaced in health telemetry so a recording's quality is auditable.

## Firmware components

| Component | Responsibility |
|---|---|
| `config_store` | NVS-backed config; never logs secrets |
| `wifi_manager` | STA connect/reconnect, RSSI, Wi-Fi events |
| `provisioning` | headless SoftAP + minimal setup page |
| `csi_capture` | `esp_wifi_set_csi*`, ISR-safe callback → bounded pool |
| `ping_source` | controlled ICMP ping at configurable PPS, seq correlation |
| `frame_pipeline` | static FrameQueue + FrameBatch pool, drop counters |
| `network_stream` | UDP batched binary streamer, bounded queue |
| `protocol` | wire (de)serialization + CRC32 (host-testable) |
| `control_api` | `esp_http_server`, `/api/v1/*`, auth, cJSON |
| `ota_manager` | `esp_https_ota` advanced API; manifest, SHA-256, rollback |
| `device_health` | counters/telemetry; no single boolean "offline" state |
| `mdns_service` | advertise hostname + service metadata |

The shared `protocol` component compiles on the host, so wire-format serialization and CRC are
unit-tested in CI without hardware (`firmware/test/host`).

## LAN tools

- **collector** binds the UDP port (default `5566`), validates magic/version/CRC, tracks
  per-`(device,boot)` sequence gaps and reboots, and writes a recording as three artifacts:
  length-prefixed raw binary (source of truth), decoded JSONL, and a metadata sidecar. It can
  also drive `capture/start` and `capture/stop` on the device.
- **ota-server** serves `/manifest/{stable,development}.json` and
  `/firmware/:version/rf-sense.bin` over HTTPS, validating files at startup and refusing to
  serve a manifest that doesn't match its firmware.
- **cli** does mDNS discovery (with direct-IP fallback) and OTA check/apply.
- **experiments** wraps the collector with a complete metadata schema and group templates, so
  every recording is self-describing for later group-aware evaluation.

## Offline analysis

The Python package parses the raw binary, reconstructs complex CSI, sanitizes phase, applies
classical filters (median / Hampel / Butterworth), extracts sliding-window features, and runs
classical classifiers under **leave-one-{person,position,day}-out** cross-validation. The
splitter guarantees that windows of a single recording never straddle the train/test boundary
— the single most important guard against fooling ourselves. There is intentionally **no deep
learning** at this stage.

## Identity, ports, and naming

| Thing | Value |
|---|---|
| Device id | low bytes of MAC; `deviceId` on the wire is CRC32 of the 6 MAC bytes |
| mDNS hostname | `rf-sense-<id>.local` |
| Provisioning AP | `RF-Sense-<ID4>`, setup page at `192.168.4.1` |
| Control API | HTTP `:80`, base path `/api/v1` |
| Collector | UDP `:5566` (configurable) |
| OTA server | HTTPS `:8443` (configurable), `rf-sense-ota.local` |
| Protocol version | `1` |
