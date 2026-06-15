"""Convert model predictions into honest, visualization-ready RF scene hypotheses.

The scene objects emitted here are not camera tracks. They are compact visual hypotheses derived
from the current classifier output, coarse zone metadata, confidence, and motion level. Every
entity carries uncertainty and provenance so the browser can render an engaging scene without
claiming more spatial precision than a single RF link provides.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np

_KEY_VALUE = re.compile(r"(?P<key>[a-z][a-z0-9_-]*)\s*[:=]\s*(?P<value>[^|;,]+)", re.I)
_COUNT = re.compile(r"(?:count|people|persons?)\s*[:= -]?\s*(\d+)", re.I)


def parse_scene_semantics(label: str, target: str = "label") -> dict[str, Any]:
    """Extract optional structured scene hints from a human-readable class label.

    Labels may remain simple (``occupied``), or use a compact convention such as
    ``count=2|pose=standing|orientation=facing-display|zone=front``. The convention lets the
    interactive trainer create richer visual classes without changing the wire protocol.
    """

    text = str(label or "").strip()
    semantics: dict[str, Any] = {}
    for match in _KEY_VALUE.finditer(text):
        key = match.group("key").lower().replace("-", "_")
        value = match.group("value").strip()
        if key in {"count", "people", "persons"}:
            try:
                semantics["count"] = max(0, int(value))
            except ValueError:
                pass
        elif key in {"pose", "orientation", "movement", "zone", "kind", "object"}:
            semantics["kind" if key == "object" else key] = value

    count_match = _COUNT.search(text)
    if count_match and "count" not in semantics:
        semantics["count"] = int(count_match.group(1))

    normalized_target = target.lower().replace("-", "_")
    if normalized_target == "count" and "count" not in semantics:
        try:
            semantics["count"] = max(0, int(float(text)))
        except ValueError:
            pass
    elif normalized_target == "position":
        semantics.setdefault("zone", text)
    elif normalized_target == "orientation":
        semantics.setdefault("orientation", text)
    elif normalized_target == "movement":
        semantics.setdefault("movement", text)
    elif normalized_target == "pose":
        semantics.setdefault("pose", text)
    elif normalized_target in {"object", "kind"}:
        semantics.setdefault("kind", text)

    lowered = text.lower()
    if "empty" in lowered or "vacant" in lowered:
        semantics.setdefault("count", 0)
    if "walking" in lowered or "moving" in lowered or "walk-by" in lowered:
        semantics.setdefault("movement", "moving")
    if "stationary" in lowered or "still" in lowered:
        semantics.setdefault("movement", "stationary")
    for pose in ("standing", "sitting", "crouching", "lying"):
        if pose in lowered:
            semantics.setdefault("pose", pose)
    if "facing" in lowered:
        semantics.setdefault("orientation", text)

    return semantics


def semantics_for_target(target: str, value: str) -> dict[str, Any]:
    """Return bundle metadata for a trained class value."""

    return parse_scene_semantics(value, target)


@dataclass
class SceneTracker:
    """Stateful adapter from predictions to normalized scene entities.

    Coordinates are normalized to 0..1. Zone transitions can yield a coarse movement vector; when
    the model has no zone output, direction is deliberately left unknown.
    """

    max_entities: int = 12
    _last_center: tuple[float, float] | None = None
    _last_ts: float | None = None
    _last_zone: str | None = None
    _trail: list[dict[str, float]] = field(default_factory=list)

    def update(
        self,
        prediction: dict[str, Any],
        *,
        zones: dict[str, dict[str, Any]] | None,
        now: float,
    ) -> dict[str, Any]:
        if not prediction.get("ready"):
            return {
                "mode": "waiting",
                "entities": [],
                "audience": {"estimate": 0, "min": 0, "max": 0, "confidence": 0.0},
                "zone": None,
                "directionKnown": False,
                "caveat": "Waiting for enough CSI frames to form a hypothesis.",
            }

        state = str(prediction.get("state", "unknown"))
        target = str(prediction.get("target", "presence"))
        confidence = float(np.clip(prediction.get("confidence", 0.0), 0.0, 1.0))
        motion = max(0.0, float(prediction.get("motion", 0.0)))
        semantics = dict(prediction.get("semantics") or parse_scene_semantics(state, target))
        zone_name = str(semantics.get("zone") or (state if target == "position" else "")) or None
        center = self._zone_center(zone_name, zones or {})
        count = self._estimate_count(state, target, semantics)
        count_min, count_max = self._count_range(count, confidence, target)
        direction = self._direction(center, zone_name, now)

        kind = str(semantics.get("kind") or ("person" if target in {"count", "pose", "orientation"} else "occupancy"))
        pose = str(semantics.get("pose") or "unknown")
        orientation = str(semantics.get("orientation") or "unknown")
        movement = str(semantics.get("movement") or ("active" if motion > 0 else "unknown"))

        visible_count = min(count, self.max_entities)
        entities = [
            self._entity(
                index=i,
                count=max(visible_count, 1),
                center=center,
                confidence=confidence,
                kind=kind,
                pose=pose,
                orientation=orientation,
                movement=movement,
                motion=motion,
                direction=direction,
                state=state,
                target=target,
            )
            for i in range(visible_count)
        ]

        if count > 0 and not entities:
            entities.append(
                self._entity(
                    index=0,
                    count=1,
                    center=center,
                    confidence=confidence,
                    kind="occupancy",
                    pose="unknown",
                    orientation="unknown",
                    movement=movement,
                    motion=motion,
                    direction=direction,
                    state=state,
                    target=target,
                )
            )

        if center is not None:
            self._trail.append({"x": center[0], "y": center[1], "ts": now})
            self._trail = self._trail[-30:]

        return {
            "mode": "model-hypothesis" if prediction.get("mode") == "model" else "rf-disturbance",
            "entities": entities,
            "audience": {
                "estimate": count,
                "min": count_min,
                "max": count_max,
                "confidence": confidence,
                "capped": count > self.max_entities,
            },
            "zone": zone_name,
            "direction": direction,
            "directionKnown": direction is not None,
            "trail": list(self._trail),
            "state": state,
            "target": target,
            "caveat": (
                "Estimated RF scene, not camera tracking. Bubble position and pose are classifier "
                "hypotheses with explicit uncertainty."
            ),
        }

    @staticmethod
    def _estimate_count(state: str, target: str, semantics: dict[str, Any]) -> int:
        if "count" in semantics:
            try:
                return max(0, int(semantics["count"]))
            except (TypeError, ValueError):
                pass
        lowered = state.lower()
        if target == "count":
            try:
                return max(0, int(float(state)))
            except ValueError:
                return 1
        if "empty" in lowered or "vacant" in lowered:
            return 0
        return 1

    @staticmethod
    def _count_range(count: int, confidence: float, target: str) -> tuple[int, int]:
        if count == 0:
            return 0, 0 if confidence >= 0.65 else 1
        if target != "count":
            return (1, 1) if confidence >= 0.8 else (0, max(1, count + 1))
        if confidence >= 0.82:
            return count, count
        if confidence >= 0.58:
            return max(0, count - 1), count + 1
        return max(0, count - 1), count + 2

    @staticmethod
    def _zone_center(
        zone_name: str | None, zones: dict[str, dict[str, Any]]
    ) -> tuple[float, float] | None:
        if not zone_name or zone_name not in zones:
            return (0.5, 0.5)
        zone = zones.get(zone_name) or {}
        x, y = zone.get("x"), zone.get("y")
        if x is None or y is None:
            return (0.5, 0.5)

        numeric = [
            (float(v.get("x")), float(v.get("y")))
            for v in zones.values()
            if isinstance(v, dict) and v.get("x") is not None and v.get("y") is not None
        ]
        if len(numeric) < 2:
            return (0.5, 0.5)
        xs, ys = zip(*numeric, strict=True)
        x_span = max(max(xs) - min(xs), 1e-9)
        y_span = max(max(ys) - min(ys), 1e-9)
        return (
            0.12 + 0.76 * (float(x) - min(xs)) / x_span,
            0.12 + 0.76 * (float(y) - min(ys)) / y_span,
        )

    def _direction(
        self, center: tuple[float, float] | None, zone_name: str | None, now: float
    ) -> dict[str, float] | None:
        if center is None or self._last_center is None or self._last_ts is None:
            self._last_center = center
            self._last_ts = now
            self._last_zone = zone_name
            return None
        dt = max(now - self._last_ts, 1e-3)
        changed_zone = bool(zone_name and self._last_zone and zone_name != self._last_zone)
        dx = center[0] - self._last_center[0]
        dy = center[1] - self._last_center[1]
        self._last_center = center
        self._last_ts = now
        self._last_zone = zone_name
        if not changed_zone or math.hypot(dx, dy) < 1e-4:
            return None
        scale = min(1.0, 0.35 / dt)
        return {"dx": dx * scale, "dy": dy * scale, "speed": math.hypot(dx, dy) / dt}

    @staticmethod
    def _entity(
        *,
        index: int,
        count: int,
        center: tuple[float, float] | None,
        confidence: float,
        kind: str,
        pose: str,
        orientation: str,
        movement: str,
        motion: float,
        direction: dict[str, float] | None,
        state: str,
        target: str,
    ) -> dict[str, Any]:
        cx, cy = center or (0.5, 0.5)
        if count > 1:
            angle = index * 2.399963229728653
            radius = 0.045 + 0.035 * math.sqrt(index)
            x = float(np.clip(cx + math.cos(angle) * radius, 0.06, 0.94))
            y = float(np.clip(cy + math.sin(angle) * radius, 0.06, 0.94))
        else:
            x, y = cx, cy
        return {
            "id": f"estimate-{index}",
            "kind": kind,
            "x": round(x, 4),
            "y": round(y, 4),
            "confidence": round(confidence, 4),
            "uncertainty": round(0.07 + (1.0 - confidence) * 0.16, 4),
            "pose": pose,
            "orientation": orientation,
            "movement": movement,
            "motion": round(motion, 5),
            "velocity": direction,
            "label": state,
            "basis": target,
        }
