"""Live web view of the current presence / coarse-zone estimate.

A source (live UDP from the device, or a replayed recording) feeds recent CSI frames into a
thread-safe buffer. An inference loop turns the most recent window into a state via `LiveEstimator`
(a trained model if one is loaded, otherwise a transparent motion heuristic). A tiny stdlib HTTP
server streams that state to the browser over Server-Sent Events; the page lights up the predicted
zone in real time.

Honesty, restated where it matters most -- in the thing people will look at: one RF link yields a
COARSE presence/zone estimate, not coordinates. The page says so, and shows the live confidence and
the (uncalibrated) motion level so the estimate can be judged, not just trusted.

No third-party web framework: only the standard library plus numpy (and joblib/sklearn if a model
is loaded). The viewer is its own UDP receiver -- point the device's collector host at the machine
running it, or use --replay to drive it from a recording with no hardware.
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from . import csi as csi_mod
from . import features as feat_mod
from . import protocol as proto
from .livemodel import LiveEstimator, load_bundle


class LiveBuffer:
    """Thread-safe ring of recent frames plus stream stats (loss, reboot, maintenance)."""

    def __init__(self, max_frames: int) -> None:
        self._frames: deque[proto.Frame] = deque(maxlen=max_frames)
        self._lock = threading.Lock()
        self.datagrams = 0
        self.invalid = 0
        self.frames_total = 0
        self.gaps = 0
        self.device_id = 0
        self.boot_id = 0
        self.maintenance = False
        self.last_recv = 0.0
        self._last_seq: dict[int, int] = {}

    def add_datagram(self, dg: proto.Datagram) -> None:
        with self._lock:
            h = dg.header
            self.datagrams += 1
            self.device_id = h.device_id
            self.boot_id = h.boot_id
            self.maintenance = bool(h.flags & proto.FLAG_MAINTENANCE)
            self.last_recv = time.monotonic()
            key = h.device_id
            prev = self._last_seq.get(key)
            if prev is not None and h.packet_seq > prev + 1:
                self.gaps += h.packet_seq - prev - 1
            self._last_seq[key] = h.packet_seq
            for f in dg.frames:
                self._frames.append(f)
                self.frames_total += 1

    def note_invalid(self) -> None:
        with self._lock:
            self.invalid += 1

    def snapshot(self) -> tuple[np.ndarray, np.ndarray, dict]:
        with self._lock:
            frames = list(self._frames)
            stats = {
                "datagrams": self.datagrams,
                "invalid": self.invalid,
                "frames": self.frames_total,
                "gaps": self.gaps,
                "deviceId": f"{self.device_id:08x}",
                "bootId": self.boot_id,
                "maintenance": self.maintenance,
                "ageSec": (time.monotonic() - self.last_recv) if self.last_recv else None,
            }
        timestamps, matrix = csi_mod.frames_to_matrix(frames)
        return timestamps, matrix, stats


class StateHolder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict = {"ready": False, "reason": "starting"}

    def set(self, state: dict) -> None:
        with self._lock:
            self._state = state

    def get(self) -> dict:
        with self._lock:
            return dict(self._state)


class InteractiveTrainer:
    """Collect labeled live windows and hot-swap a small display classifier."""

    def __init__(self, estimator: LiveEstimator) -> None:
        self._lock = threading.Lock()
        self._estimator = estimator
        self._active_label: str | None = None
        self._features: list[np.ndarray] = []
        self._labels: list[str] = []
        self._last_frame_total = -1
        self._status = "Start with step 1: record the empty room."

    def predict(self, matrix: np.ndarray) -> dict:
        with self._lock:
            estimator = self._estimator
        return estimator.predict_complex(matrix)

    def meta(self) -> dict:
        with self._lock:
            return _meta(self._estimator)

    def start(self, label: str) -> None:
        label = label.strip()
        if not label or len(label) > 64:
            raise ValueError("label must be 1-64 characters")
        with self._lock:
            self._active_label = label
            self._status = f"Tagging live windows as '{label}'."

    def stop(self) -> None:
        with self._lock:
            self._active_label = None
            self._status = "Tagging stopped."

    def collect(self, matrix: np.ndarray, frame_total: int) -> None:
        with self._lock:
            label = self._active_label
            window = self._estimator.window
            feature = self._estimator.feature
            if label is None or frame_total == self._last_frame_total or matrix.shape[0] < window:
                return
            self._last_frame_total = frame_total
        block = matrix[-window:]
        values = csi_mod.sanitize_phase(block) if feature == "phase" else np.abs(block)
        row = feat_mod.window_features(values)
        with self._lock:
            self._features.append(row)
            self._labels.append(label)

    def train(self) -> None:
        from sklearn.ensemble import RandomForestClassifier

        with self._lock:
            labels = list(self._labels)
            if len(set(labels)) < 2:
                raise ValueError("tag at least two distinct labels before training")
            counts = {label: labels.count(label) for label in sorted(set(labels))}
            if min(counts.values()) < 5:
                raise ValueError("collect at least 5 windows for every label before training")
            x = np.vstack(self._features)
            current = self._estimator
        model = RandomForestClassifier(
            n_estimators=200, class_weight="balanced", random_state=42, n_jobs=-1
        )
        model.fit(x, labels)
        classes = [str(value) for value in model.classes_]
        bundle = {
            "format": "rfsense-live-model/1",
            "model": model,
            "classes": classes,
            "target": "label",
            "model_name": "random_forest",
            "feature": current.feature,
            "imag_first": True,
            "window": current.window,
            "step": current.window,
            "n_features": int(x.shape[1]),
            "zones": {label: {"x": None, "y": None} for label in classes},
        }
        with self._lock:
            self._estimator = LiveEstimator(bundle)
            self._active_label = None
            self._status = f"Model trained on {len(labels)} labeled windows."

    def status(self) -> dict:
        with self._lock:
            counts: dict[str, int] = {}
            for label in self._labels:
                counts[label] = counts.get(label, 0) + 1
            return {
                "activeLabel": self._active_label,
                "counts": counts,
                "total": len(self._labels),
                "status": self._status,
                "mode": self._estimator.mode,
                "classes": self._estimator.classes,
            }


def udp_source(buffer: LiveBuffer, host: str, port: int, stop: threading.Event) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.settimeout(0.5)
    print(f"[live] listening for CSI on udp://{host}:{port}")
    try:
        while not stop.is_set():
            try:
                data, _addr = sock.recvfrom(2048)
            except TimeoutError:
                continue
            try:
                buffer.add_datagram(proto.parse_datagram(data))
            except proto.ProtocolError:
                buffer.note_invalid()
    finally:
        sock.close()


def replay_source(
    buffer: LiveBuffer, path: str, speed: float, stop: threading.Event, loop: bool
) -> None:
    print(f"[live] replaying {path} at {speed}x" + (" (looping)" if loop else ""))
    while not stop.is_set():
        prev_ts: int | None = None
        for dg in proto.read_bin(path):
            if stop.is_set():
                return
            if dg.frames:
                ts = dg.frames[0].timestamp_us
                if prev_ts is not None:
                    delay = max(0.0, (ts - prev_ts) / 1e6 / max(speed, 1e-6))
                    # Cap any single sleep so a gap in the recording doesn't freeze the view.
                    time.sleep(min(delay, 2.0))
                prev_ts = ts
            buffer.add_datagram(dg)
        if not loop:
            print("[live] replay finished (view will go stale)")
            return


def follow_source(buffer: LiveBuffer, path: str, stop: threading.Event) -> None:
    """Tail complete length-prefixed datagrams from a collector recording as it grows."""
    print(f"[live] following collector recording {path}")
    pos = 0
    recording = Path(path)
    while not stop.is_set():
        try:
            with recording.open("rb") as fh:
                fh.seek(pos)
                prefix = fh.read(4)
                if len(prefix) < 4:
                    stop.wait(0.05)
                    continue
                (length,) = struct.unpack("<I", prefix)
                payload = fh.read(length)
                if len(payload) < length:
                    stop.wait(0.05)
                    continue
                pos += 4 + length
            try:
                buffer.add_datagram(proto.parse_datagram(payload))
            except proto.ProtocolError:
                buffer.note_invalid()
        except FileNotFoundError:
            stop.wait(0.25)


def inference_loop(
    buffer: LiveBuffer,
    trainer: InteractiveTrainer,
    holder: StateHolder,
    interval: float,
    stop: threading.Event,
) -> None:
    motion_hist: deque[float] = deque(maxlen=120)
    signal_hist: deque[float] = deque(maxlen=120)
    while not stop.is_set():
        timestamps, matrix, stats = buffer.snapshot()
        trainer.collect(matrix, stats["frames"])
        result = trainer.predict(matrix)
        rate = 0.0
        if timestamps.size > 1:
            span = (timestamps[-1] - timestamps[0]) / 1e6
            if span > 0:
                rate = float((timestamps.size - 1) / span)
        loss_ppm = 0.0
        total = stats["datagrams"] + stats["gaps"]
        if total > 0:
            loss_ppm = 1e6 * stats["gaps"] / total
        if result.get("ready"):
            motion_hist.append(round(float(result.get("motion", 0.0)), 5))
        amplitude_profile: list[float] = []
        if matrix.size:
            recent_amplitude = np.abs(matrix[-min(8, matrix.shape[0]) :])
            profile = np.median(recent_amplitude, axis=0)
            amplitude_profile = np.round(profile, 2).tolist()
            signal_hist.append(round(float(np.mean(profile)), 3))
        state = {
            **result,
            "frameRateHz": round(rate, 1),
            "lossPpm": round(loss_ppm, 1),
            "motionHistory": list(motion_hist),
            "signalHistory": list(signal_hist),
            "amplitudeProfile": amplitude_profile,
            "subcarrierCount": len(amplitude_profile),
            "stats": stats,
            "ts": time.time(),
        }
        holder.set(state)
        stop.wait(interval)


def _meta(estimator: LiveEstimator) -> dict:
    return {
        "mode": estimator.mode,
        "target": estimator.target,
        "classes": estimator.classes,
        "zones": estimator.zones,
        "window": estimator.window,
        "feature": estimator.feature,
    }


def _make_handler(holder: StateHolder, trainer: InteractiveTrainer, interval: float):
    page = _PAGE

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # silence per-request logging
            pass

        def _send(self, code: int, ctype: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - required name
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                self._send(200, "text/html; charset=utf-8", page.encode("utf-8"))
            elif path == "/meta":
                self._send(200, "application/json", json.dumps(trainer.meta()).encode("utf-8"))
            elif path == "/state":
                self._send(200, "application/json", json.dumps(holder.get()).encode("utf-8"))
            elif path == "/training":
                self._send(200, "application/json", json.dumps(trainer.status()).encode("utf-8"))
            elif path == "/events":
                self._stream()
            else:
                self._send(404, "text/plain", b"not found")

        def do_POST(self) -> None:  # noqa: N802 - required name
            path = urlparse(self.path).path
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                if path == "/training/start":
                    trainer.start(str(body.get("label", "")))
                elif path == "/training/stop":
                    trainer.stop()
                elif path == "/training/train":
                    trainer.train()
                else:
                    self._send(404, "text/plain", b"not found")
                    return
                self._send(200, "application/json", json.dumps(trainer.status()).encode("utf-8"))
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, "application/json", json.dumps({"error": str(exc)}).encode("utf-8"))

        def _stream(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                while True:
                    payload = json.dumps(holder.get())
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(interval)
            except (BrokenPipeError, ConnectionResetError):
                return

    return Handler


def run(
    *,
    source: str,
    udp_host: str,
    udp_port: int,
    replay: str | None,
    replay_speed: float,
    replay_loop: bool,
    model_path: str | None,
    http_host: str,
    http_port: int,
    interval: float,
    window: int,
    motion_threshold: float | None,
) -> int:
    bundle = load_bundle(model_path) if model_path else None
    estimator = LiveEstimator(bundle, window=window, motion_threshold=motion_threshold)
    trainer = InteractiveTrainer(estimator)
    buffer = LiveBuffer(max_frames=max(window * 8, 256))
    holder = StateHolder()
    stop = threading.Event()

    if source == "replay":
        if not replay:
            raise SystemExit("--replay PATH is required when source=replay")
        src = threading.Thread(
            target=replay_source,
            args=(buffer, replay, replay_speed, stop, replay_loop),
            daemon=True,
        )
    elif source == "follow":
        if not replay:
            raise SystemExit("--follow PATH is required when source=follow")
        src = threading.Thread(target=follow_source, args=(buffer, replay, stop), daemon=True)
    else:
        src = threading.Thread(
            target=udp_source, args=(buffer, udp_host, udp_port, stop), daemon=True
        )
    infer = threading.Thread(
        target=inference_loop, args=(buffer, trainer, holder, interval, stop), daemon=True
    )
    src.start()
    infer.start()

    httpd = ThreadingHTTPServer((http_host, http_port), _make_handler(holder, trainer, interval))
    httpd.daemon_threads = True
    print(f"[live] mode={estimator.mode} target={estimator.target} classes={estimator.classes}")
    print(f"[live] open http://{http_host}:{http_port}/  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[live] shutting down")
    finally:
        stop.set()
        httpd.shutdown()
    return 0


_PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RF-Sense live view</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
  header { padding: 12px 18px; background: #161b22; border-bottom: 1px solid #30363d; }
  header h1 { margin: 0; font-size: 16px; }
  .caveat { margin-top: 4px; color: #f0b429; font-size: 12px; }
  .wrap { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
          gap: 14px; padding: 14px; }
  .stage, .panel, .chart { background: #161b22; border: 1px solid #30363d;
           border-radius: 10px; padding: 14px; min-width: 0; }
  .diagnostics { display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
                 padding: 0 14px 14px; }
  .chart h2 { margin: 0 0 8px; font-size: 13px; color: #adbac7; }
  .wide { grid-column: 1 / -1; }
  svg { width: 100%; height: auto; display: block; }
  .zone { fill: #21262d; stroke: #30363d; stroke-width: 1.5; transition: fill .2s, r .2s; }
  .zone.active { fill: #2ea043; stroke: #3fb950; }
  .zlabel { fill: #adbac7; font-size: 11px; text-anchor: middle; }
  .range-ring { fill: none; stroke: #3d4753; stroke-width: .7; stroke-dasharray: 2 2; }
  .range-label { fill: #8b949e; font-size: 4px; }
  .device-node { fill: #58a6ff; stroke: #b6dbff; stroke-width: 1; }
  .pulse-ring { fill: rgba(240,180,41,.28); stroke: #f0b429; stroke-width: 1.2;
                filter: drop-shadow(0 0 5px #f0b429);
                transition: r .18s, opacity .18s, stroke-width .18s, fill .18s, stroke .18s; }
  .motion-label { fill: #f6d365; font-size: 5px; font-weight: 700; text-anchor: middle; }
  .big { font-size: 30px; font-weight: 700; margin: 2px 0 8px; }
  .big.empty { color: #768390; } .big.occupied, .big.active { color: #3fb950; }
  .row { display: flex; justify-content: space-between; padding: 3px 0;
         border-bottom: 1px solid #21262d; }
  .row span:last-child { font-variant-numeric: tabular-nums; }
  .bar { height: 10px; background: #21262d; border-radius: 5px; overflow: hidden; margin: 6px 0 12px; }
  .bar > i { display: block; height: 100%; background: #3fb950; width: 0%; transition: width .2s; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #f85149;
         margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: #3fb950; } .dot.stale { background: #f0b429; }
  .muted { color: #768390; font-size: 12px; }
  canvas { width: 100%; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; }
  #spark { height: 70px; } #profile { height: 210px; } #waterfall { height: 230px; }
  .axis { color: #768390; display:flex; justify-content:space-between; font-size:11px; }
  .trainer { margin-top: 14px; padding-top: 12px; border-top: 1px solid #30363d; }
  .trainer h2 { margin: 0 0 4px; font-size: 15px; }
  .step { margin-top: 9px; padding: 9px; background: #0d1117; border: 1px solid #30363d;
          border-radius: 7px; }
  .step.ready { border-color: #2ea043; }
  .step strong { display: block; margin-bottom: 2px; }
  .controls { display: flex; gap: 6px; }
  input, button { font: inherit; border-radius: 6px; border: 1px solid #30363d; }
  input { min-width: 0; flex: 1; padding: 7px 8px; background: #0d1117; color: #e6edf3; }
  button { padding: 7px 10px; background: #21262d; color: #e6edf3; cursor: pointer; }
  button.primary { background: #238636; border-color: #2ea043; }
  button:disabled { opacity: .5; cursor: default; }
  .progress { height: 7px; margin-top: 7px; background: #21262d; border-radius: 4px; overflow: hidden; }
  .progress i { display: block; height: 100%; width: 0; background: #58a6ff; transition: width .2s; }
  #trainStatus { margin-top: 8px; }
  #tagCounts { margin-top: 5px; color: #adbac7; font-size: 12px; }
  @media (max-width: 760px) {
    .wrap, .diagnostics { grid-template-columns: 1fr; }
    .wide { grid-column: auto; }
  }
</style>
</head>
<body>
<header>
  <h1>RF-Sense live view — <span id="mode">…</span></h1>
  <div class="caveat" id="caveat">One RF link gives a coarse presence/zone estimate, not exact
    positions. Treat this as the model's live readout, judged together with confidence and motion.</div>
</header>
<div class="wrap">
  <div class="stage">
    <div class="muted">range rings are reference zones; centered pulse shows RF disturbance
      intensity, not a measured person or distance</div>
    <svg id="map" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"></svg>
  </div>
  <div class="panel">
    <div class="muted">predicted state</div>
    <div class="big" id="state">—</div>
    <div class="muted">confidence</div>
    <div class="bar"><i id="conf"></i></div>
    <div class="muted">motion level (uncalibrated)</div>
    <div class="big" id="motionValue">—</div>
    <canvas id="spark" width="240" height="48"></canvas>
    <div style="margin-top:12px">
      <div class="row"><span><span class="dot" id="link"></span>stream</span><span id="conn">connecting…</span></div>
      <div class="row"><span>frame rate</span><span id="rate">— Hz</span></div>
      <div class="row"><span>packet loss</span><span id="loss">— ppm</span></div>
      <div class="row"><span>device</span><span id="dev">—</span></div>
      <div class="row"><span>subcarriers</span><span id="subs">—</span></div>
      <div class="row"><span>target</span><span id="target">—</span></div>
    </div>
    <div class="trainer">
      <h2>Calibrate your room</h2>
      <div class="muted">Complete these steps while the live stream is green.</div>
      <div class="step" id="emptyStep">
        <strong>1. Record the empty room</strong>
        <div class="muted">Step away and keep the RF path clear.</div>
        <button class="primary" id="recordEmpty">Record empty room (12 sec)</button>
      </div>
      <div class="step" id="walkStep">
        <strong>2. Record yourself walking by</strong>
        <div class="muted">Walk between the ESP32 and Wi-Fi access point several times.</div>
        <button class="primary" id="recordWalk">Record walk-by (12 sec)</button>
      </div>
      <div class="progress"><i id="calibrationProgress"></i></div>
      <div class="step" id="trainStep">
        <strong>3. Train the detector</strong>
        <div class="muted">This creates a local display model from the two recordings.</div>
        <button id="train" disabled>Train detector</button>
      </div>
      <details style="margin-top:8px">
        <summary class="muted">Add another condition</summary>
        <div class="controls" style="margin-top:6px">
          <input id="label" maxlength="64" placeholder="e.g. sitting at desk" />
          <button id="recordCustom">Record (12 sec)</button>
        </div>
      </details>
      <div class="muted" id="trainStatus">Loading training status…</div>
      <div id="tagCounts"></div>
    </div>
  </div>
</div>
<div class="diagnostics">
  <div class="chart">
    <h2>CSI amplitude by subcarrier</h2>
    <canvas id="profile" width="720" height="210"></canvas>
    <div class="axis"><span>subcarrier 0</span><span id="profileRange">relative amplitude</span><span id="subEnd">—</span></div>
  </div>
  <div class="chart">
    <h2>Motion and mean signal history</h2>
    <canvas id="history" width="720" height="210"></canvas>
    <div class="axis"><span>older</span><span>green: motion · blue: mean amplitude</span><span>now</span></div>
  </div>
  <div class="chart wide">
    <h2>CSI waterfall — recent amplitude profiles</h2>
    <canvas id="waterfall" width="1200" height="230"></canvas>
    <div class="axis"><span>older</span><span>color = relative amplitude across subcarriers</span><span>newest</span></div>
  </div>
</div>
<script>
let META = { zones: {}, classes: [], mode: "", target: "" };
let WATERFALL = [];
const $ = (id) => document.getElementById(id);

function layoutZones() {
  const svg = $("map"); svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const rings = [[15, "0–3 ft"], [29, "3–6 ft"], [43, "6–10 ft"]];
  rings.forEach(([r, label]) => {
    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", 50); ring.setAttribute("cy", 50); ring.setAttribute("r", r);
    ring.setAttribute("class", "range-ring"); svg.appendChild(ring);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", 51); t.setAttribute("y", 50 - r + 4);
    t.setAttribute("class", "range-label"); t.textContent = label; svg.appendChild(t);
  });
  const device = document.createElementNS(ns, "circle");
  device.setAttribute("cx", 50); device.setAttribute("cy", 50); device.setAttribute("r", 4);
  device.setAttribute("class", "device-node"); svg.appendChild(device);
  const deviceText = document.createElementNS(ns, "text");
  deviceText.setAttribute("x", 50); deviceText.setAttribute("y", 58);
  deviceText.setAttribute("class", "zlabel"); deviceText.textContent = "ESP32";
  svg.appendChild(deviceText);
  const pulse = document.createElementNS(ns, "circle");
  pulse.setAttribute("id", "pulseRing"); pulse.setAttribute("cx", 50);
  pulse.setAttribute("cy", 50); pulse.setAttribute("r", 4);
  pulse.setAttribute("class", "pulse-ring"); pulse.setAttribute("opacity", 0);
  svg.appendChild(pulse);
  const motionText = document.createElementNS(ns, "text");
  motionText.setAttribute("id", "motionBubbleLabel"); motionText.setAttribute("x", 50);
  motionText.setAttribute("y", 18); motionText.setAttribute("class", "motion-label");
  motionText.textContent = "RF disturbance"; svg.appendChild(motionText);
}

function drawSpark(hist) {
  const cv = $("spark"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (!hist || hist.length < 2) return;
  const max = Math.max(...hist, 1e-9);
  ctx.beginPath(); ctx.strokeStyle = "#3fb950"; ctx.lineWidth = 1.5;
  hist.forEach((v, i) => {
    const x = (w * i) / (hist.length - 1), y = h - (h - 4) * (v / max) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function drawSeries(id, series, colors) {
  const cv = $(id), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = i * h / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const all = series.flat().filter(Number.isFinite);
  if (all.length < 2) return;
  series.forEach((values, si) => {
    if (!values || values.length < 2) return;
    const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(hi - lo, 1e-9);
    ctx.beginPath(); ctx.strokeStyle = colors[si]; ctx.lineWidth = 2;
    values.forEach((v, i) => {
      const x = 4 + (w - 8) * i / (values.length - 1);
      const y = h - 5 - (h - 10) * (v - lo) / span;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
}

function drawProfile(values) {
  const cv = $("profile"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(hi - lo, 1e-9);
  ctx.fillStyle = "rgba(88,166,255,.18)"; ctx.strokeStyle = "#58a6ff"; ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (w - 8) * i / (values.length - 1) + 4;
    const y = h - 5 - (h - 12) * (v - lo) / span;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke(); ctx.lineTo(w - 4, h - 4); ctx.lineTo(4, h - 4); ctx.closePath(); ctx.fill();
  $("profileRange").textContent = lo.toFixed(1) + " – " + hi.toFixed(1);
  $("subEnd").textContent = "subcarrier " + (values.length - 1);
}

function drawWaterfall(values) {
  if (!values || values.length < 2) return;
  WATERFALL.push(values); if (WATERFALL.length > 80) WATERFALL.shift();
  const cv = $("waterfall"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const rowH = h / 80;
  WATERFALL.forEach((row, ri) => {
    const lo = Math.min(...row), hi = Math.max(...row), span = Math.max(hi - lo, 1e-9);
    row.forEach((v, i) => {
      const t = (v - lo) / span;
      const r = Math.round(30 + 225 * t), g = Math.round(70 + 130 * (1 - Math.abs(t - .5) * 2));
      const b = Math.round(180 * (1 - t));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i * w / row.length, ri * rowH, Math.ceil(w / row.length), Math.ceil(rowH));
    });
  });
}

function render(s) {
  const conn = $("conn"), link = $("link");
  const stale = s.stats && s.stats.ageSec != null && s.stats.ageSec > 3;
  if (!s.ready) {
    conn.textContent = s.reason || "waiting"; link.className = "dot";
    $("state").textContent = "—"; return;
  }
  conn.textContent = stale ? "stale (" + s.stats.ageSec.toFixed(1) + "s)" : "live";
  link.className = "dot " + (stale ? "stale" : "ok");
  const st = $("state");
  st.textContent = s.state + (s.mode === "heuristic" ? "" : "");
  st.className = "big " + (s.state === "empty" ? "empty" : "active");
  $("conf").style.width = Math.round(100 * (s.confidence || 0)) + "%";
  $("motionValue").textContent = Number(s.motion || 0).toFixed(2);
  $("rate").textContent = (s.frameRateHz ?? 0) + " Hz";
  $("loss").textContent = (s.lossPpm ?? 0) + " ppm";
  $("dev").textContent = s.stats ? s.stats.deviceId : "—";
  $("subs").textContent = s.subcarrierCount || "—";
  $("target").textContent = s.target || META.target;
  drawSpark(s.motionHistory);
  drawProfile(s.amplitudeProfile);
  drawSeries("history", [s.motionHistory || [], s.signalHistory || []], ["#3fb950", "#58a6ff"]);
  drawWaterfall(s.amplitudeProfile);
  const pulse = $("pulseRing");
  const hist = s.motionHistory || [], motion = hist.length ? hist[hist.length - 1] : 0;
  const sorted = [...hist].sort((a, b) => a - b);
  const reference = sorted.length ? sorted[Math.floor(sorted.length * .8)] : 0;
  const intensity = Math.min(1, motion / Math.max(reference * 1.5, 1e-6));
  pulse.setAttribute("r", 8 + 34 * intensity);
  pulse.setAttribute("opacity", .28 + .72 * intensity);
  pulse.setAttribute("stroke-width", 1.5 + 3.5 * intensity);
  const hot = intensity > .72;
  pulse.setAttribute("stroke", hot ? "#f85149" : "#f0b429");
  pulse.setAttribute("fill", hot ? "rgba(248,81,73,.34)" : "rgba(240,180,41,.28)");
  $("motionBubbleLabel").textContent = hot ? "STRONG RF DISTURBANCE" : "RF disturbance";
}

async function boot() {
  META = await (await fetch("/meta")).json();
  $("mode").textContent = META.mode === "model"
    ? "model: " + META.target : "motion heuristic (no model loaded)";
  if (META.mode !== "model")
    $("caveat").textContent += "  No trained model is loaded, so this is a transparent "
      + "motion-based presence indicator, not localization.";
  layoutZones();
  const es = new EventSource("/events");
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = () => { $("conn").textContent = "reconnecting…"; $("link").className = "dot"; };
  async function trainingPost(path, body = {}) {
    const response = await fetch(path, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "request failed");
    showTraining(data);
    return data;
  }
  function showTraining(data) {
    $("trainStatus").textContent = data.status;
    $("tagCounts").textContent = Object.entries(data.counts)
      .map(([label, count]) => `${label}: ${count}`).join(" · ") || "No tagged windows yet.";
    const emptyReady = (data.counts.empty || 0) >= 5;
    const walkReady = (data.counts["walk-by"] || 0) >= 5;
    $("emptyStep").classList.toggle("ready", emptyReady);
    $("walkStep").classList.toggle("ready", walkReady);
    $("trainStep").classList.toggle("ready", emptyReady && walkReady);
    $("train").disabled = !(emptyReady && walkReady) || !!data.activeLabel;
    $("recordEmpty").disabled = !!data.activeLabel;
    $("recordWalk").disabled = !!data.activeLabel;
    $("recordCustom").disabled = !!data.activeLabel;
    if (data.mode === "model") {
      META.mode = "model"; META.target = "label";
      $("mode").textContent = "model: label";
      $("caveat").textContent = "One RF link gives a coarse presence/zone estimate, not exact "
      + "positions. This model was trained from tagged live windows and is a display aid.";
    }
  }
  let calibrationTimer = null;
  async function recordFor(label, seconds = 12) {
    if (calibrationTimer) return;
    try {
      await trainingPost("/training/start", {label});
      const started = Date.now();
      $("trainStatus").textContent = `Recording “${label}” — ${seconds}s remaining`;
      calibrationTimer = setInterval(async () => {
        const elapsed = (Date.now() - started) / 1000;
        const remaining = Math.max(0, Math.ceil(seconds - elapsed));
        $("calibrationProgress").style.width = Math.min(100, 100 * elapsed / seconds) + "%";
        $("trainStatus").textContent = `Recording “${label}” — ${remaining}s remaining`;
        if (elapsed >= seconds) {
          clearInterval(calibrationTimer); calibrationTimer = null;
          $("calibrationProgress").style.width = "0";
          try {
            const data = await trainingPost("/training/stop");
            $("trainStatus").textContent = `Recorded “${label}”. Continue to the next step.`;
            showTraining(data);
          } catch (error) { $("trainStatus").textContent = error.message; }
        }
      }, 200);
    } catch (error) { $("trainStatus").textContent = error.message; }
  }
  $("recordEmpty").onclick = () => recordFor("empty");
  $("recordWalk").onclick = () => recordFor("walk-by");
  $("recordCustom").onclick = () => {
    const label = $("label").value.trim();
    if (!label) { $("trainStatus").textContent = "Enter a name for the condition first."; return; }
    recordFor(label);
  };
  $("train").onclick = async () => {
    $("trainStatus").textContent = "Training…";
    try { await trainingPost("/training/train"); }
    catch (error) { $("trainStatus").textContent = error.message; }
  };
  showTraining(await (await fetch("/training")).json());
  setInterval(async () => {
    try { showTraining(await (await fetch("/training")).json()); } catch (_) {}
  }, 1000);
}
boot();
</script>
</body>
</html>
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Serve a live presence/zone web view from CSI.")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--udp-port", type=int, default=5566, help="UDP port to receive CSI on")
    src.add_argument("--replay", help="replay a .csi.bin recording instead of listening on UDP")
    src.add_argument("--follow", help="follow a growing collector .csi.bin recording")
    ap.add_argument("--udp-host", default="0.0.0.0")
    ap.add_argument("--replay-speed", type=float, default=1.0)
    ap.add_argument("--replay-loop", action="store_true")
    ap.add_argument("--model", help="path to a bundle from `rfsense-train` (else motion heuristic)")
    ap.add_argument("--http-host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8080)
    ap.add_argument("--interval", type=float, default=0.2, help="inference / push interval seconds")
    ap.add_argument("--window", type=int, default=64, help="frames per inference window")
    ap.add_argument(
        "--motion-threshold",
        type=float,
        default=None,
        help="fixed heuristic motion threshold (default: adaptive baseline)",
    )
    args = ap.parse_args(argv)

    return run(
        source="replay" if args.replay else ("follow" if args.follow else "udp"),
        udp_host=args.udp_host,
        udp_port=args.udp_port,
        replay=args.replay or args.follow,
        replay_speed=args.replay_speed,
        replay_loop=args.replay_loop,
        model_path=args.model,
        http_host=args.http_host,
        http_port=args.http_port,
        interval=args.interval,
        window=args.window,
        motion_threshold=args.motion_threshold,
    )


if __name__ == "__main__":
    raise SystemExit(main())
