# CSI streaming protocol (v1 batch + v2 joint-localization frame)

This is the single source of truth for CSI datagrams. The legacy v1 `RFCS` batch remains
supported for coarse-zone diagnostics. Continuous XY uses the v2 `RFV2` frame so four receivers
can align observations by transmitter packet identity instead of by independent receiver clocks.

If you change either wire format, bump `protocolVersion`, update firmware protocol code, the Node
collector/dashboard decoder, the Python analysis parser, and this file together.

## Design goals

- **Raw fidelity.** CSI I/Q bytes are streamed exactly as ESP-IDF hands them to the capture
  callback. Neither the firmware nor the collector alters CSI values.
- **Loss-detectable.** A monotonic per-device `packetSeq` lets the collector count loss.
- **Reboot-detectable.** A `bootId` (random per boot) lets the collector tell a reboot apart
  from packet loss.
- **MTU-safe.** A datagram never exceeds `kMaxDatagramSize` (1400 bytes) so it fits in one
  Ethernet/Wi-Fi frame without IP fragmentation.
- **Cheap to emit.** No per-frame JSON; fixed-width little-endian fields plus a CRC32.

All multi-byte integers are **little-endian**. There is no padding beyond what is written
below; every implementation serializes field-by-field (never by struct punning).

## v1 datagram = header (32 B) + payload (N frame records) + CRC32 (4 B)

### Datagram header — 32 bytes

| Offset | Size | Field             | Type | Notes |
|-------:|-----:|-------------------|------|-------|
| 0      | 4    | `magic`           | u8[4] | ASCII `R F C S` = `0x52 0x46 0x43 0x53` |
| 4      | 1    | `protocolVersion` | u8   | `1` |
| 5      | 1    | `flags`           | u8   | bit0 = maintenance (device entering OTA); others reserved 0 |
| 6      | 1    | `captureMode`     | u8   | 0 controlled, 1 normal, 2 passive |
| 7      | 1    | `reserved0`       | u8   | 0 |
| 8      | 4    | `deviceId`        | u32  | derived from device MAC (CRC32 of the 6 MAC bytes) |
| 12     | 4    | `bootId`          | u32  | random, regenerated each boot |
| 16     | 4    | `packetSeq`       | u32  | per-device, increments by 1 per datagram, wraps at 2^32 |
| 20     | 4    | `batchSeq`        | u32  | logical batch counter (may equal packetSeq) |
| 24     | 2    | `frameCount`      | u16  | number of frame records in payload |
| 26     | 2    | `payloadLen`      | u16  | total bytes of all frame records |
| 28     | 4    | `reserved1`       | u32  | 0 |

### Frame record — 28-byte fixed header + `csiLen` raw bytes

| Offset | Size | Field              | Type | Notes |
|-------:|-----:|--------------------|------|-------|
| 0      | 4    | `frameSeq`         | u32  | per-device monotonic CSI frame counter |
| 4      | 8    | `timestampUs`      | u64  | `esp_timer_get_time()` micros at capture |
| 12     | 4    | `pingSeq`          | u32  | controlled-mode ping sequence, or `0xFFFFFFFF` if N/A |
| 16     | 1    | `rssi`             | i8   | dBm |
| 17     | 1    | `noiseFloor`       | i8   | dBm |
| 18     | 1    | `channel`          | u8   | primary channel |
| 19     | 1    | `secondaryChannel` | u8   | 0 none, 1 above, 2 below |
| 20     | 1    | `bandwidth`        | u8   | 0 = 20 MHz, 1 = 40 MHz |
| 21     | 1    | `phyMode`          | u8   | 0 11b, 1 11g, 2 HT (11n), 3 HT40 |
| 22     | 1    | `rate`             | u8   | IDF `rx_ctrl.rate` |
| 23     | 1    | `firstWordInvalid` | u8   | IDF `first_word_invalid` flag (1 = drop first 4 CSI bytes when processing) |
| 24     | 2    | `linkId`           | u16  | stable experiment link id (low 16 bits of a BSSID hash) — never a raw MAC |
| 26     | 2    | `csiLen`           | u16  | number of raw CSI bytes that follow |
| 28     | csiLen | `csi`            | i8[] | raw signed I/Q values, exactly as ESP-IDF provided |

### Trailer — 4 bytes

| Field | Type | Notes |
|-------|------|-------|
| `crc32` | u32 | IEEE 802.3 CRC32 (reflected, poly `0xEDB88320`) over bytes `[0, 32 + payloadLen)` |

## Size budget

```
kMaxDatagramSize = 1400
payload budget   = 1400 - 32 (header) - 4 (crc) = 1364 bytes
frame size       = 28 + csiLen
```

The firmware appends frames to a datagram until the next frame would exceed
`kMaxDatagramSize`, then sends and starts a new datagram. Typical ESP32-S3 HT20 CSI is
128–384 bytes per frame, i.e. ~3–9 frames per datagram.

## Loss / reboot accounting (collector)

- Track `(deviceId)` → last `packetSeq`. A gap of `g` means `g - 1` lost datagrams.
- A change in `bootId` for the same `deviceId` is a **reboot**, not loss; reset the
  per-device `packetSeq` baseline and start a new recording segment.
- `frameSeq` gaps within a stream reflect on-device queue drops (the device dropped frames
  before they were ever batched); these are reported separately from network loss.

## Health telemetry (separate, low-rate)

Device health is **not** part of this binary stream. It is exposed as JSON via
`GET /api/v1/health` (HTTP) and optionally as a low-rate JSON UDP heartbeat. Raw CSI is
never JSON-encoded per frame.

## v2 continuous-XY frame = fixed header (39 B) + CSI payload + CRC32 (4 B)

Protocol v2 carries exactly one receiver observation for one transmitter packet. It is intentionally
not a per-receiver classifier payload. The dashboard aligns frames with the same
`(transmitterId, transmitterBootId, transmitterPacketSeq)` across receiver slots A-D before building
one joint feature window.

### v2 fixed header — 39 bytes

| Offset | Size | Field                  | Type  | Notes |
|-------:|-----:|------------------------|-------|-------|
| 0      | 4    | `magic`                | u8[4] | ASCII `R F V 2` = `0x52 0x46 0x56 0x32` |
| 4      | 1    | `protocolVersion`      | u8    | `2` |
| 5      | 4    | `receiverFrameSeq`     | u32   | per-receiver CSI frame counter |
| 9      | 8    | `receiverTimestampUs`  | u64   | receiver local timestamp at capture |
| 17     | 4    | `transmitterId`        | u32   | stable transmitter identifier, never a raw MAC |
| 21     | 4    | `transmitterBootId`    | u32   | transmitter boot/session identifier |
| 25     | 4    | `transmitterPacketSeq` | u32   | shared packet sequence observed by all receivers |
| 29     | 1    | `rssi`                 | i8    | dBm |
| 30     | 1    | `noiseFloor`           | i8    | dBm, 0 when unavailable |
| 31     | 1    | `channel`              | u8    | primary channel |
| 32     | 1    | `bandwidthMhz`         | u8    | currently 20 or 40 |
| 33     | 1    | `firstWordInvalid`     | u8    | 1 = drop first 4 CSI bytes when processing |
| 34     | 2    | `csiLen`               | u16   | number of raw CSI bytes that follow |
| 36     | 3    | `reserved`             | u8[3] | 0 |
| 39     | csiLen | `csi`                | i8[]  | raw signed I/Q values |

### v2 trailer — 4 bytes

| Field | Type | Notes |
|-------|------|-------|
| `crc32` | u32 | IEEE 802.3 CRC32 over bytes `[0, 39 + csiLen)` |

## v2 alignment rules

- Receiver identity comes from configured receiver source mapping, not from a raw MAC inside the
  frame.
- Four observations for the same transmitter packet are normal.
- Three observations are allowed only as degraded mode and must be reflected in uncertainty.
- Two or fewer observations must not produce an accepted XY estimate.
- Asynchronous receiver windows must never be treated as one observation.
