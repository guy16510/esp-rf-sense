# Hardware XY validation

This workflow validates physical receivers before any position claim is made. A static page,
synthetic packet stream, or hard-coded slot list is not evidence.

## Setup

Use Node 22:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --version
```

Start or reuse the four-node dashboard:

```bash
npm run dashboard -- \
  --http-host 0.0.0.0 \
  --http-port 8080 \
  --udp-host 0.0.0.0 \
  --udp-port 5566 \
  --required-nodes 4 \
  --min-frame-rate 5 \
  --recordings-dir recordings/hardware-xy \
  --model-path models/hardware-position.json \
  --slot-a <device-a> \
  --slot-b <device-b> \
  --slot-c <device-c> \
  --slot-d <device-d>
```

## Receiver mapping

Firmware must expose `POST /api/v1/identify`. Then map physical slots:

```bash
npm run hardware:identify
```

The script blinks one receiver at a time and writes `config/hardware-room.json`. If one receiver
has no identify LED, it may be assigned by elimination only when exactly one slot remains.
After moving receivers, run the same command with `-- --reposition` to re-enter actual receiver
coordinates.

## Placement gate

`config/hardware-room.json` must record approximate room dimensions and actual receiver
coordinates. Receivers clustered near each other may still pass four-stream readiness, but they
must not be used to claim calibrated position validation. The scripts block position recording and
training unless receiver coordinates span at least half the room width and half the room height.

## Stream validation

```bash
npm run hardware:streams -- --dashboard-url http://127.0.0.1:8080 --duration 30
```

This writes `artifacts/hardware/latest/four-stream-report.json`. PASS requires four unique fresh
receivers, age under 1 second, at least 5 Hz per receiver, nonzero CSI width, no duplicate IDs, and
packet loss under 10%.

## Calibration recordings

```bash
npm run hardware:record-xy -- --dashboard-url http://127.0.0.1:8080 --seconds 75 --frames 2000
```

The script records two independent runs each for empty, left, center, right, front, and back. It
stores subject, date, movement, position label, normalized coordinates, and an independent
recording group in each metadata file.

## Training and live checks

```bash
npm run hardware:train-position -- --dashboard-url http://127.0.0.1:8080
npm run hardware:check-position -- --expected center --x-meters 2 --y-meters 2 --duration 30
```

The output is a calibrated coarse-zone coordinate. It is not true continuous XY interpolation.

## Continuous XY validation requirement

Continuous XY requires protocol v2 (`RFV2`) recordings with shared
`transmitterId`, `transmitterBootId`, and `transmitterPacketSeq` across the four receivers. The
dashboard may load coarse-zone models for diagnostics, but `/api/meta` must keep
`validatedContinuousXY: false` until a recorded held-out dataset passes the localization gates and
uploads the validation artifact.
