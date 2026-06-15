# Live view — "where is someone right now?"

`rfsense-live` serves a small web page that shows, in real time, the current **presence /
coarse-zone** estimate from the CSI stream. It is part of the Python analysis package
(`tools/analysis`) because it reuses the exact same feature pipeline and models as
`rfsense-evaluate` / `rfsense-train` — there is no second implementation to drift.

> **Read this first — what one RF link can and cannot show.** A single TX/RX link does **not**
> produce coordinates. The honest output is *presence* (empty vs. occupied) and, with a trained
> model, a *coarse zone* (which labelled position is most likely). The page says so on screen and
> shows live confidence and an uncalibrated motion level so the estimate can be **judged, not just
> trusted**. See [known-limitations.md](known-limitations.md).

## Two modes

| Mode | When | What it shows |
|---|---|---|
| **Motion heuristic** | no `--model` given | Transparent presence indicator. Tracks a quiet-floor baseline and flags "occupied" when motion rises clearly above it (z-score > k). No localization claim. |
| **Model** | `--model bundle.joblib` given | Runs a trained classifier per window. `target=position` lights up the most likely **zone**; `target=label` shows the predicted experiment class (e.g. empty vs. occupied). |

The mode is shown in the page header. With no model loaded the page explicitly labels itself a
motion-based presence indicator, not localization.

## Feeding it data

The viewer is **its own UDP receiver**. Two processes cannot bind the same UDP port, so you cannot
run it on the same port as the collector at the same time. Pick one:

- **Live, no collector running:** point the device's `collectorHost` at the machine running the
  viewer and use `--udp-port 5566` (the default capture port).
- **Live, alongside a collector:** run the viewer on a *different* host/port, or
- **No hardware at all:** replay a recording with `--replay path/to/run.csi.bin`. This is also how
  the feature is exercised in tests.

## Quick start (no hardware) — replay a recording

```bash
cd tools/analysis
pip install -e ".[dev]"            # installs joblib + sklearn used here
rfsense-live --replay ../../recordings/run1/<name>.csi.bin --replay-loop
# open http://127.0.0.1:8080/
```

With no `--model`, you get the motion heuristic — good for confirming the wiring and seeing the
motion sparkline respond.

## Train a live model, then localize by zone

Headline accuracy must come from `rfsense-evaluate` with leave-one-{person,position,day}-out. The
live model is a **display aid**: it is fit on *all* sessions so it can label the current window, so
it will look better than it is and must never be quoted as accuracy.

```bash
# Fit one classifier on every session, keyed on the labelled positions, and save a bundle.
rfsense-train ../../recordings --out live-model.joblib --target position --window 64 --step 32

# Serve the live zone view driven by that model (live UDP example).
rfsense-live --model live-model.joblib --udp-port 5566
```

If your positions carry `x`/`y` coordinates (set via `--position` in the experiment runner; see
[experiment-protocol.md](experiment-protocol.md)), the page draws them as a floor-plan and lights
up the active zone. Otherwise zones are arranged on a ring. A `subcarrier mismatch` message on the
page means the live channel/bandwidth differs from what the model was trained on — retrain or match
the capture settings.

## Options

```
rfsense-live
  --udp-port N           UDP port to receive CSI on (default 5566)   [mutually exclusive with --replay]
  --replay PATH          replay a .csi.bin recording instead of listening on UDP
  --udp-host HOST        bind address for UDP (default 0.0.0.0)
  --replay-speed F       replay rate multiplier (default 1.0)
  --replay-loop          loop the recording instead of going stale at the end
  --model PATH           bundle from `rfsense-train` (omit for the motion heuristic)
  --http-host HOST       web bind address (default 127.0.0.1 — localhost only)
  --http-port N          web port (default 8080)
  --interval SEC         inference / push interval (default 0.2)
  --window N             frames per inference window (default 64)
  --motion-threshold F   fixed heuristic threshold (default: adaptive baseline)
```

The web server binds `127.0.0.1` by default so the view is not exposed on the network. It uses only
the Python standard library (HTTP + Server-Sent Events) plus numpy; no web framework. There is no
authentication and no data storage — it is a read-only local view, in keeping with the lab's scope
(no dashboards, no cloud; see [known-limitations.md](known-limitations.md)).
