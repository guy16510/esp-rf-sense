# Experiment protocol

The point of this lab is an **honest** evaluation, so the experiment process is built to make
self-deception hard: every recording is fully self-describing, and the analysis splits data by
person / position / day so that "it works" can never mean "it memorized this room on this
afternoon." This document is the procedure; [known-limitations.md](known-limitations.md) is the
list of claims the data does *not* support.

## Roles

- **Transmitter:** an existing, unmodified 2.4 GHz router/AP. We never flash or reconfigure it.
- **Receiver:** one ESP32-S3 capturing CSI from frames it receives from that router.
- **Stimulus (controlled mode):** the device pings the router at a fixed rate so each reply is a
  CSI sample tagged with its ping sequence.
- **Collector:** a LAN host recording the raw UDP stream.

## Capture modes

| Mode | How frames are produced | Use |
|---|---|---|
| `controlled` | device sends ICMP echo at a fixed PPS; replies carry CSI, tagged by `pingSeq` | **primary** — steady, timing-controlled sampling |
| `normal` | harvest CSI from ordinary traffic to/from the router | realism, uncontrolled rate |
| `passive` | observe frames without generating any | least invasive, least control |

Default ping rate is `25` pps (`AppConfig.h`); set per experiment via the metadata `link.pingPps`.

## Metadata schema (every recording)

The schema is `tools/experiments/src/metadata.ts` and is validated before a session is accepted.
The fields that the analysis pipeline depends on for leakage-free evaluation are first-class:

- **`subject.subjectIds`** — stable pseudonymous id per person → leave-one-**person**-out.
- **`subject.position`** (label + optional x/y/z) → leave-one-**position**-out.
- **`day`** (`YYYY-MM-DD`) → leave-one-**day**-out.
- **`label`** — the ground-truth class (`empty`, `occupied-moving`, …).
- **`link`** — `txDescription`, `channel`, `pingPps`, optional TX/RX positions.
- **`subject`** — `count`, `movement` (`none|stationary|walking|mixed`), `orientation`, optional
  `body[]` measurements.
- **`device`** — firmware version, git commit, boot id, target, board, protocol version (filled
  from the device's `/status`).
- **`counts`** — valid/invalid datagrams, frames, reboots, packet-loss ppm, and on-device queue
  drops (filled at stop from collector stats + device health, so loss is part of the record).
- **`complete`** — remains false until the collector exits cleanly and records at least one frame.
  Analysis skips incomplete sessions.

Validation enforces, among other things, that `subjectIds.length === count` for non-empty
sessions and that `day` is `YYYY-MM-DD`. **Body measurements are optional and experimental** —
recorded only with consent, and never used to make a claim unless it survives leave-one-person-out.

## Experiment templates

`tools/experiments/src/templates.ts` ships starting groups:

| Template `group` | Label | What it probes |
|---|---|---|
| `empty-baseline` | `empty` | no-subject CSI reference (the baseline everything is compared against) |
| `moving` | `occupied-moving` | one subject walking — motion / Doppler |
| `stationary` | `occupied-stationary` | one subject standing still — presence vs. empty (the hard case) |
| `position-grid` | `occupied-positioned` | one subject at labeled grid positions — coarse localization |
| `multi-person` | `occupied-multi` | two or more subjects — how far people-counting can be pushed |

```bash
npm run experiment:start -- --template list   # show templates
```

## Running a session

The experiment runner wraps the collector: it reads the device `/status` snapshot, starts
capture, records for a fixed duration, then stops cleanly and finalizes counts from the
collector's metadata sidecar and the device's `/health`.

```bash
export RF_SENSE_DEVICE=rf-sense-a1b2.local
export RF_SENSE_TOKEN=...

npm run experiment:start -- \
  --template stationary --experiment-id occupancy-room-A --room "room A" \
  --day 2026-06-15 --subject-id p3 --position deskA --duration 120
npm run experiment:status
npm run experiment:stop
```

The admin token is passed to the spawned collector as an argument array (never through a shell),
so it does not leak into shell history or process listings.

## Designing a credible dataset

To support generalization claims you need **diversity across the very axes you will split on**:

- **People:** several distinct subjects (≥4–5) so leave-one-person-out has something to leave out.
- **Positions:** the same class captured at multiple labeled positions.
- **Days/sessions:** repeat on different days — multipath drifts, and a model that only works
  within one session is not detecting people, it is detecting the furniture and the calibration.
- **Balanced classes:** comparable amounts of `empty` and each occupied condition.
- **Always anchor to an `empty-baseline`** recorded close in time to the occupied runs.

## From recordings to results

Each session yields the collector's three artifacts (raw binary, JSONL, meta) plus the
experiment `*.session.json`. Offline:

```bash
cd tools/analysis
rfsense-evaluate --data /path/to/recordings --group person   # or: position | day
```

The evaluator builds a feature table with per-window provenance (`Sample(recording_id, label,
subject_id, position, day)`), then runs classical models under leave-one-group-out CV. The
splitter **refuses to place windows of one recording on both sides** of a split, and every fold
reports balanced accuracy against a majority-class baseline computed from the training labels.
Beating that baseline under leave-one-*-out is the bar; in-recording accuracy is not.

For a *live* readout during or after a session — presence and coarse zone, not coordinates — see
[live-view.md](live-view.md) (`rfsense-train` to fit a display model, `rfsense-live` to serve it).
That model is fit on all data for display only and must **never** be quoted as accuracy; headline
numbers come from `rfsense-evaluate` above.
