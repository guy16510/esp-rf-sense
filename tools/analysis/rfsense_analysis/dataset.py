"""Load experiment sessions into a feature table with per-window provenance and targets.

Every window remains tied to its recording/person/position/day so group-aware evaluation cannot
leak adjacent samples. Richer scene targets are retained as aligned arrays for count, movement,
orientation, pose, room, and kind models used by the interactive dashboard.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import csi as csi_mod
from . import features as feat_mod
from . import protocol as proto
from .splits import Sample


@dataclass
class LoadedDataset:
    x: np.ndarray
    samples: list[Sample]
    position_coords: dict[str, dict] = field(default_factory=dict)
    targets: dict[str, list[str]] = field(default_factory=dict)
    n_sessions: int = 0

    @property
    def labels(self) -> list[str]:
        return [s.label for s in self.samples]

    def target_table(self, target: str) -> tuple[np.ndarray, list[str]]:
        """Return feature rows and non-empty labels for one supported model target."""

        normalized = target.lower().replace("-", "_")
        if normalized == "label":
            values = self.labels
        elif normalized == "position":
            values = [s.position for s in self.samples]
        else:
            values = self.targets.get(normalized, [])
        if len(values) != self.x.shape[0]:
            raise SystemExit(f"target '{target}' is unavailable or misaligned with feature rows")
        mask = np.array([bool(str(value).strip()) for value in values], dtype=bool)
        if not np.any(mask):
            raise SystemExit(f"target '{target}' has no populated values in the session metadata")
        return self.x[mask], [str(value) for value, keep in zip(values, mask, strict=True) if keep]


def _read_recording(path: Path) -> list[proto.Datagram]:
    if path.name.endswith(".csi.bin") or path.suffix == ".bin":
        return list(proto.read_bin(path))
    if path.suffix == ".jsonl":
        return list(proto.read_jsonl(path))
    raise SystemExit(f"unrecognized recording extension: {path} (expected .csi.bin or .jsonl)")


def matrix_for(datagrams: list[proto.Datagram]) -> tuple[np.ndarray, np.ndarray]:
    frames = list(proto.iter_frames(iter(datagrams)))
    return csi_mod.frames_to_matrix(frames)


def _position(session: dict) -> tuple[str, float | None, float | None]:
    pos = (session.get("subject") or {}).get("position")
    if isinstance(pos, dict):
        return str(pos.get("label", "")), pos.get("x"), pos.get("y")
    return "", None, None


def _session_targets(session: dict, position: str) -> dict[str, str]:
    subject = session.get("subject") or {}
    count = subject.get("count")
    return {
        "count": "" if count is None else str(count),
        "movement": str(subject.get("movement") or ""),
        "orientation": str(subject.get("orientation") or ""),
        "pose": str(subject.get("pose") or ""),
        "kind": str(subject.get("kind") or "person" if (count or 0) > 0 else ""),
        "room": str(session.get("room") or ""),
        "position": position,
        "label": str(session.get("label") or ""),
    }


def load_session_dir(
    session_dir: str | Path,
    *,
    window: int,
    step: int,
    feature: str = "amplitude",
    on_skip: Callable[[str], None] | None = None,
) -> LoadedDataset:
    """Build a feature table from every complete session with a usable recording."""

    session_dir = Path(session_dir)
    sessions = sorted(session_dir.glob("*.session.json"))
    if not sessions:
        raise SystemExit(f"no *.session.json files in {session_dir}")

    skip = on_skip or (lambda _m: None)
    x_blocks: list[np.ndarray] = []
    samples: list[Sample] = []
    position_coords: dict[str, dict] = {}
    targets: dict[str, list[str]] = {
        "count": [],
        "movement": [],
        "orientation": [],
        "pose": [],
        "kind": [],
        "room": [],
        "position": [],
        "label": [],
    }
    used = 0

    for sp in sessions:
        session = json.loads(sp.read_text())
        if session.get("complete") is not True:
            skip(f"skip {sp.name}: session is incomplete")
            continue
        rec_name = session["recordingName"]
        rec_path = session_dir / f"{rec_name}.csi.bin"
        if not rec_path.exists():
            rec_path = session_dir / f"{rec_name}.jsonl"
        if not rec_path.exists():
            skip(f"skip {sp.name}: no recording found for '{rec_name}'")
            continue

        _, matrix = matrix_for(_read_recording(rec_path))
        if matrix.size == 0:
            skip(f"skip {sp.name}: no usable frames")
            continue

        feature_input = (
            csi_mod.sanitize_phase(matrix) if feature == "phase" else csi_mod.amplitude(matrix)
        )
        x, _windows = feat_mod.build_feature_table(feature_input, window=window, step=step)
        if x.shape[0] == 0:
            skip(f"skip {sp.name}: recording too short for window={window}")
            continue

        pos_label, px, py = _position(session)
        if pos_label and pos_label not in position_coords:
            position_coords[pos_label] = {"x": px, "y": py}

        subj = session.get("subject") or {}
        subject_ids = subj.get("subjectIds") or []
        sample = Sample(
            recording_id=session["sessionId"],
            label=session["label"],
            subject_id=subject_ids[0] if subject_ids else "",
            position=pos_label,
            day=session.get("day", ""),
        )
        x_blocks.append(x)
        samples.extend([sample] * x.shape[0])
        values = _session_targets(session, pos_label)
        for key in targets:
            targets[key].extend([values[key]] * x.shape[0])
        used += 1

    if not x_blocks:
        raise SystemExit("no usable sessions")
    return LoadedDataset(
        x=np.vstack(x_blocks),
        samples=samples,
        position_coords=position_coords,
        targets=targets,
        n_sessions=used,
    )
