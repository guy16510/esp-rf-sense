"""Interactive near-real-time RF scene dashboard.

This module keeps the existing CSI capture, training, and inference pipeline intact, then adapts each
prediction into a visualization-ready scene hypothesis. The browser receives updates over SSE at the
same cadence as inference and renders them with D3.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np

from . import csi as csi_mod
from .live import (
    InteractiveTrainer,
    LiveBuffer,
    StateHolder,
    follow_source,
    replay_source,
    udp_source,
)
from .livemodel import LiveEstimator, load_bundle
from .scene import SceneTracker

WEB_ROOT = Path(__file__).with_name("web")


class HistoryHolder:
    """Thread-safe rolling state history for timeline bootstrapping and short scrubbing."""

    def __init__(self, max_items: int = 1800) -> None:
        self._items: deque[dict[str, Any]] = deque(maxlen=max_items)
        self._lock = threading.Lock()

    def append(self, state: dict[str, Any]) -> None:
        with self._lock:
            self._items.append(state)

    def get(self, seconds: float | None = None) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._items)
        if seconds is None or not items:
            return items
        cutoff = time.time() - max(1.0, seconds)
        return [item for item in items if float(item.get("ts", 0.0)) >= cutoff]


class MarkerStore:
    """In-memory campaign and interaction markers overlaid on the live timeline."""

    ALLOWED_TYPES = {"campaign_start", "campaign_end", "interaction", "note"}

    def __init__(self, max_items: int = 500) -> None:
        self._items: deque[dict[str, Any]] = deque(maxlen=max_items)
        self._lock = threading.Lock()
        self._sequence = 0

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        marker_type = str(payload.get("type", "note"))
        if marker_type not in self.ALLOWED_TYPES:
            raise ValueError(f"type must be one of {', '.join(sorted(self.ALLOWED_TYPES))}")
        label = str(payload.get("label", "")).strip()[:120]
        campaign_id = str(payload.get("campaignId", "")).strip()[:120]
        with self._lock:
            self._sequence += 1
            marker = {
                "id": self._sequence,
                "type": marker_type,
                "label": label,
                "campaignId": campaign_id,
                "ts": float(payload.get("ts") or time.time()),
            }
            self._items.append(marker)
        return marker

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._items)


def inference_loop(
    buffer: LiveBuffer,
    trainer: InteractiveTrainer,
    holder: StateHolder,
    history: HistoryHolder,
    tracker: SceneTracker,
    interval: float,
    stop: threading.Event,
) -> None:
    motion_hist: deque[float] = deque(maxlen=300)
    signal_hist: deque[float] = deque(maxlen=300)
    confidence_hist: deque[float] = deque(maxlen=300)
    while not stop.is_set():
        timestamps, matrix, stats = buffer.snapshot()
        trainer.collect(matrix, stats["frames"])
        result = trainer.predict(matrix)
        meta = trainer.meta()

        rate = 0.0
        if timestamps.size > 1:
            span = (timestamps[-1] - timestamps[0]) / 1e6
            if span > 0:
                rate = float((timestamps.size - 1) / span)
        total = stats["datagrams"] + stats["gaps"]
        loss_ppm = 1e6 * stats["gaps"] / total if total > 0 else 0.0

        if result.get("ready"):
            motion_hist.append(round(float(result.get("motion", 0.0)), 5))
            confidence_hist.append(round(float(result.get("confidence", 0.0)), 5))

        amplitude_profile: list[float] = []
        if matrix.size:
            recent_amplitude = np.abs(matrix[-min(8, matrix.shape[0]) :])
            profile = np.median(recent_amplitude, axis=0)
            amplitude_profile = np.round(profile, 2).tolist()
            signal_hist.append(round(float(np.mean(profile)), 3))

        now = time.time()
        scene = tracker.update(result, zones=meta.get("zones") or {}, now=now)
        state = {
            **result,
            "scene": scene,
            "frameRateHz": round(rate, 1),
            "lossPpm": round(loss_ppm, 1),
            "motionHistory": list(motion_hist),
            "signalHistory": list(signal_hist),
            "confidenceHistory": list(confidence_hist),
            "amplitudeProfile": amplitude_profile,
            "subcarrierCount": len(amplitude_profile),
            "stats": stats,
            "ts": now,
        }
        holder.set(state)
        history.append(state)
        stop.wait(interval)


def _dashboard_meta(trainer: InteractiveTrainer, interval: float) -> dict[str, Any]:
    meta = trainer.meta()
    meta.update(
        {
            "streamIntervalMs": round(interval * 1000),
            "capabilities": {
                "sceneHypotheses": True,
                "peopleCount": meta.get("target") == "count",
                "pose": meta.get("target") == "pose",
                "orientation": meta.get("target") == "orientation",
                "coarseDirection": meta.get("target") == "position",
                "campaignMarkers": True,
                "history": True,
            },
            "disclaimer": (
                "Visual entities are RF-derived hypotheses, not camera tracks. Exact identity, "
                "pose, orientation, and coordinates require a validated model and suitable links."
            ),
        }
    )
    return meta


def _make_handler(
    holder: StateHolder,
    history: HistoryHolder,
    trainer: InteractiveTrainer,
    markers: MarkerStore,
    interval: float,
):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RFSenseDashboard/1"

        def log_message(self, *_args) -> None:
            pass

        def _send(self, code: int, ctype: str, body: bytes, *, cache: str = "no-store") -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, value: Any) -> None:
            self._send(code, "application/json; charset=utf-8", json.dumps(value).encode("utf-8"))

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 64 * 1024:
                raise ValueError("request body is too large")
            value = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(value, dict):
                raise ValueError("request body must be a JSON object")
            return value

        def _static(self, path: str) -> bool:
            relative = "index.html" if path in {"/", "/index.html"} else path.removeprefix("/")
            if relative not in {"index.html", "styles.css", "app.js", "scene-view.js", "timeline.js"}:
                return False
            target = WEB_ROOT / relative
            if not target.is_file():
                self._send(404, "text/plain; charset=utf-8", b"dashboard asset not found")
                return True
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            cache = "public, max-age=300" if target.name != "index.html" else "no-store"
            self._send(200, f"{ctype}; charset=utf-8", target.read_bytes(), cache=cache)
            return True

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path
            if self._static(path):
                return
            if path == "/api/meta":
                self._json(200, _dashboard_meta(trainer, interval))
            elif path == "/api/state":
                self._json(200, holder.get())
            elif path == "/api/history":
                query = parse_qs(parsed.query)
                try:
                    seconds = float(query.get("seconds", ["120"])[0])
                except ValueError:
                    seconds = 120.0
                self._json(200, history.get(min(max(seconds, 1.0), 600.0)))
            elif path == "/api/training":
                self._json(200, trainer.status())
            elif path == "/api/markers":
                self._json(200, markers.list())
            elif path == "/events":
                self._stream()
            else:
                self._send(404, "text/plain; charset=utf-8", b"not found")

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            try:
                body = self._read_json()
                if path == "/api/training/start":
                    trainer.start(str(body.get("label", "")))
                    self._json(200, trainer.status())
                elif path == "/api/training/stop":
                    trainer.stop()
                    self._json(200, trainer.status())
                elif path == "/api/training/train":
                    trainer.train()
                    self._json(200, trainer.status())
                elif path == "/api/markers":
                    self._json(201, markers.add(body))
                else:
                    self._send(404, "text/plain; charset=utf-8", b"not found")
            except (ValueError, json.JSONDecodeError) as exc:
                self._json(400, {"error": str(exc)})

        def _stream(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                event_id = 0
                while True:
                    event_id += 1
                    payload = json.dumps(holder.get(), separators=(",", ":"))
                    self.wfile.write(f"id: {event_id}\nevent: state\ndata: {payload}\n\n".encode())
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
    history = HistoryHolder()
    markers = MarkerStore()
    tracker = SceneTracker()
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
        target=inference_loop,
        args=(buffer, trainer, holder, history, tracker, interval, stop),
        daemon=True,
    )
    src.start()
    infer.start()

    httpd = ThreadingHTTPServer(
        (http_host, http_port), _make_handler(holder, history, trainer, markers, interval)
    )
    httpd.daemon_threads = True
    print(f"[dashboard] mode={estimator.mode} target={estimator.target} classes={estimator.classes}")
    print(f"[dashboard] open http://{http_host}:{http_port}/  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[dashboard] shutting down")
    finally:
        stop.set()
        httpd.shutdown()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Serve the interactive D3 RF scene dashboard.")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--udp-port", type=int, default=5566, help="UDP port to receive CSI on")
    src.add_argument("--replay", help="replay a .csi.bin recording instead of listening on UDP")
    src.add_argument("--follow", help="follow a growing collector .csi.bin recording")
    ap.add_argument("--udp-host", default="0.0.0.0")
    ap.add_argument("--replay-speed", type=float, default=1.0)
    ap.add_argument("--replay-loop", action="store_true")
    ap.add_argument("--model", help="path to a bundle from rfsense-train")
    ap.add_argument("--http-host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8080)
    ap.add_argument("--interval", type=float, default=0.2, help="inference / SSE interval seconds")
    ap.add_argument("--window", type=int, default=64, help="frames per inference window")
    ap.add_argument("--motion-threshold", type=float, default=None)
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
