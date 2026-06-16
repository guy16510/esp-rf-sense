"""Command-line entry points for the RF-Sense analysis package."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from . import csi as csi_mod
from . import dataset as dataset_mod
from . import features as feat_mod
from . import models as models_mod
from . import protocol as proto


def _read_recording(path: Path):
    if path.suffix == ".bin" or path.name.endswith(".csi.bin"):
        return list(proto.read_bin(path))
    if path.suffix == ".jsonl":
        return list(proto.read_jsonl(path))
    raise SystemExit(f"unrecognized recording extension: {path} (expected .csi.bin or .jsonl)")


def _matrix_for(datagrams) -> tuple[np.ndarray, np.ndarray]:
    frames = list(proto.iter_frames(iter(datagrams)))
    return csi_mod.frames_to_matrix(frames)


def parse_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Summarize a CSI recording.")
    ap.add_argument("recording", help="path to a .csi.bin or .jsonl recording")
    args = ap.parse_args(argv)
    datagrams = _read_recording(Path(args.recording))
    timestamps, matrix = _matrix_for(datagrams)
    n_frames, n_sub = matrix.shape if matrix.size else (0, 0)
    devices = {dg.header.device_id for dg in datagrams}
    boots = {(dg.header.device_id, dg.header.boot_id) for dg in datagrams}
    span_us = int(timestamps[-1] - timestamps[0]) if timestamps.size > 1 else 0
    rate = (n_frames - 1) / (span_us / 1e6) if span_us > 0 else 0.0
    print(f"datagrams:        {len(datagrams)}")
    print(f"usable frames:    {n_frames}")
    print(f"subcarriers:      {n_sub}")
    print(f"devices:          {sorted(hex(d) for d in devices)}")
    print(f"boot sessions:    {len(boots)}")
    print(f"approx frame rate:{rate:8.1f} Hz")
    if matrix.size:
        q = csi_mod.subcarrier_quality(matrix)
        dead = int(np.sum(q["zero_fraction"] > 0.5))
        print(f"mean amplitude:   {float(q['mean_amplitude'].mean()):.2f}")
        print(f"dead subcarriers: {dead} (>50% zero)")
    return 0


def features_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Extract windowed features from a recording.")
    ap.add_argument("recording")
    ap.add_argument("--window", type=int, default=128, help="frames per window")
    ap.add_argument("--step", type=int, default=64, help="window step in frames")
    ap.add_argument("--phase", action="store_true", help="use sanitized phase instead of amplitude")
    ap.add_argument("--out", required=True, help="output .npz path")
    args = ap.parse_args(argv)
    datagrams = _read_recording(Path(args.recording))
    _, matrix = _matrix_for(datagrams)
    if matrix.size == 0:
        raise SystemExit("no usable frames in recording")
    feature_input = csi_mod.sanitize_phase(matrix) if args.phase else csi_mod.amplitude(matrix)
    x, windows = feat_mod.build_feature_table(feature_input, window=args.window, step=args.step)
    starts = np.array([w.start for w in windows], dtype=np.int64)
    np.savez(args.out, X=x, window_starts=starts, window=args.window, step=args.step)
    print(f"wrote {x.shape[0]} windows x {x.shape[1]} features -> {args.out}")
    return 0


def evaluate_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Run group-aware classical-ML baselines over a session directory."
    )
    ap.add_argument("session_dir", help="directory containing *.session.json + matching recordings")
    ap.add_argument("--window", type=int, default=128)
    ap.add_argument("--step", type=int, default=64)
    ap.add_argument(
        "--group",
        choices=["person", "position", "day", "recording"],
        default="recording",
        help="cross-validation grouping (what is held out)",
    )
    ap.add_argument("--phase", action="store_true", help="use sanitized phase instead of amplitude")
    ap.add_argument(
        "--models", default="all", help="comma-separated subset of model names, or 'all'"
    )
    args = ap.parse_args(argv)
    ds = dataset_mod.load_session_dir(
        args.session_dir,
        window=args.window,
        step=args.step,
        feature="phase" if args.phase else "amplitude",
        on_skip=print,
    )
    y_all = ds.labels
    print(
        f"feature table: {ds.x.shape[0]} windows x {ds.x.shape[1]} features, "
        f"{len(set(y_all))} classes, {ds.n_sessions} session(s)\n"
    )
    all_models = models_mod.make_models()
    chosen = (
        all_models
        if args.models == "all"
        else {k: all_models[k] for k in args.models.split(",") if k in all_models}
    )
    if not chosen:
        raise SystemExit(f"no valid models selected; available: {', '.join(all_models)}")
    for name, model in chosen.items():
        report = models_mod.evaluate_group_cv(
            ds.x, y_all, ds.samples, group_key=args.group, model_name=name, model=model
        )
        print(report.summary())
    return 0


def train_main(argv: list[str] | None = None) -> int:
    from .scene_model import SUPPORTED_TARGETS

    ap = argparse.ArgumentParser(
        description="Fit a classifier for the live scene display. Report accuracy only with "
        "rfsense-evaluate and proper group-aware holdouts."
    )
    ap.add_argument("session_dir", help="directory containing *.session.json + matching recordings")
    ap.add_argument("--out", required=True, help="output live-model bundle path (.joblib)")
    ap.add_argument(
        "--target",
        choices=sorted(SUPPORTED_TARGETS),
        default="position",
        help="scene attribute to predict for the live dashboard",
    )
    ap.add_argument("--model", default="random_forest", help="model name from rfsense models")
    ap.add_argument("--window", type=int, default=64)
    ap.add_argument("--step", type=int, default=32)
    ap.add_argument("--phase", action="store_true", help="use sanitized phase instead of amplitude")
    args = ap.parse_args(argv)
    from . import livemodel, scene_model
    feature = "phase" if args.phase else "amplitude"
    ds = dataset_mod.load_session_dir(
        args.session_dir, window=args.window, step=args.step, feature=feature, on_skip=print
    )
    bundle = scene_model.train_scene_model(
        ds,
        target=args.target,
        model_name=args.model,
        window=args.window,
        step=args.step,
        feature=feature,
    )
    livemodel.save_bundle(bundle, args.out)
    print(
        f"trained {args.model} on {ds.x.shape[0]} windows from {ds.n_sessions} session(s); "
        f"{len(bundle['classes'])} {args.target} classes -> {args.out}"
    )
    print("note: this bundle is for the live view only; report accuracy with rfsense-evaluate.")
    return 0


def live_main(argv: list[str] | None = None) -> int:
    from . import dashboard
    return dashboard.main(argv)


def legacy_live_main(argv: list[str] | None = None) -> int:
    from . import live
    return live.main(argv)


if __name__ == "__main__":
    raise SystemExit(parse_main())
