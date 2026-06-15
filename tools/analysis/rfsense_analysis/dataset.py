"""Load a directory of experiment sessions into a feature table with per-window provenance.

A session directory contains `*.session.json` files (the experiment metadata) alongside the
collector recordings they reference. This module turns that into an (X, samples) feature table
where every window carries the recording/person/position/day it came from -- the provenance the
group-aware cross-validation in `splits` and the live model both depend on.

Shared by `rfsense-evaluate`, `rfsense-train`, and the live viewer so they all build features the
same way.
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
    x: np.ndarray  # (n_windows, n_features)
    samples: list[Sample]  # one per window, in row order
    position_coords: dict[str, dict] = field(default_factory=dict)  # position label -> {"x","y"}
    n_sessions: int = 0

    @property
    def labels(self) -> list[str]:
        return [s.label for s in self.samples]


def _read_recording(path: Path) -> list[proto.Datagram]:
    if path.name.endswith(".csi.bin") or path.suffix == ".bin":
        return list(proto.read_bin(path))
    if path.suffix == ".jsonl":
        return list(proto.read_jsonl(path))
    raise SystemExit(f"unrecognized recording extension: {path} (expected .csi.bin or .jsonl)")


def matrix_for(datagrams: list[proto.Datagram]) -> tuple[np.ndarray, np.ndarray]:
    """(timestamps_us, complex csi matrix) for all frames across the given datagrams."""
    frames = list(proto.iter_frames(iter(datagrams)))
    return csi_mod.frames_to_matrix(frames)


def _position(session: dict) -> tuple[str, float | None, float | None]:
    pos = (session.get("subject") or {}).get("position")
    if isinstance(pos, dict):
        return str(pos.get("label", "")), pos.get("x"), pos.get("y")
    return "", None, None


def load_session_dir(
    session_dir: str | Path,
    *,
    window: int,
    step: int,
    feature: str = "amplitude",
    on_skip: Callable[[str], None] | None = None,
) -> LoadedDataset:
    """Build a feature table from every session whose recording is present and long enough.

    `feature` is "amplitude" or "phase" (sanitized). `on_skip(message)` is called for each session
    that is skipped (missing recording, no usable frames, too short) so callers can report it.
    """
    session_dir = Path(session_dir)
    sessions = sorted(session_dir.glob("*.session.json"))
    if not sessions:
        raise SystemExit(f"no *.session.json files in {session_dir}")

    skip = on_skip or (lambda _m: None)
    x_blocks: list[np.ndarray] = []
    samples: list[Sample] = []
    position_coords: dict[str, dict] = {}
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
        used += 1

    if not x_blocks:
        raise SystemExit("no usable sessions")
    return LoadedDataset(
        x=np.vstack(x_blocks),
        samples=samples,
        position_coords=position_coords,
        n_sessions=used,
    )
