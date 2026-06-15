"""Export a dependency-free nearest-prototype model for the Node dashboard runtime."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .dataset import load_session_dir


def export_portable(
    session_dir: str,
    *,
    target: str,
    window: int,
    step: int,
    feature: str,
) -> dict:
    dataset = load_session_dir(session_dir, window=window, step=step, feature=feature)
    x, labels = dataset.target_table(target)
    classes = sorted(set(labels))
    if len(classes) < 2:
        raise SystemExit(f"need at least two populated {target} classes")

    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale = np.where(scale > 1e-12, scale, 1.0)
    normalized = (x - mean) / scale
    label_array = np.asarray(labels)
    prototypes = {
        label: normalized[label_array == label].mean(axis=0).tolist() for label in classes
    }
    zones = {
        label: dict(dataset.position_coords.get(label, {"x": None, "y": None}))
        if target == "position"
        else {"x": None, "y": None}
        for label in classes
    }
    return {
        "format": "rfsense-portable-model/1",
        "target": target,
        "window": window,
        "nFeatures": int(x.shape[1]),
        "classes": classes,
        "featureMean": mean.tolist(),
        "featureScale": scale.tolist(),
        "prototypes": prototypes,
        "zones": zones,
        "temperature": 1.0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export an offline RF model for dependency-free Node inference."
    )
    parser.add_argument("session_dir")
    parser.add_argument("--out", required=True)
    parser.add_argument("--target", choices=["label", "position"], default="label")
    parser.add_argument("--window", type=int, default=64)
    parser.add_argument("--step", type=int, default=32)
    parser.add_argument("--phase", action="store_true")
    args = parser.parse_args(argv)

    bundle = export_portable(
        args.session_dir,
        target=args.target,
        window=args.window,
        step=args.step,
        feature="phase" if args.phase else "amplitude",
    )
    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(bundle, indent=2) + "\n")
    print(f"wrote {len(bundle['classes'])} classes -> {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
