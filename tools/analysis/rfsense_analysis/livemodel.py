"""Train, persist, and run the small classifier that drives the live view.

Two honest caveats are built into this module:

  1. The live model is trained on ALL available data so it can label the current window. That is
     the right thing for a live display but the WRONG thing for measuring accuracy -- a model that
     has seen every recording will look better than it is. Headline accuracy must always come from
     `rfsense-evaluate` with leave-one-{person,position,day}-out, never from this model.
  2. With one RF link the prediction is a coarse presence/zone estimate, not a position. When no
     model is loaded the live view falls back to a transparent motion heuristic and says so.

The feature pipeline is identical to training/evaluation (`features.window_features`) so the live
window is described the same way the model was trained on.
"""

from __future__ import annotations

import numpy as np

from . import csi as csi_mod
from . import features as feat_mod
from .dataset import LoadedDataset

BUNDLE_FORMAT = "rfsense-live-model/1"


def train_model(
    dataset: LoadedDataset,
    *,
    target: str = "position",
    model_name: str = "random_forest",
    window: int,
    step: int,
    feature: str = "amplitude",
) -> dict:
    """Fit one classifier on the whole dataset and return a self-describing live-model bundle.

    target="position" predicts the (coarse) zone for a "where" view; target="label" predicts the
    experiment class (e.g. empty vs occupied) for a presence view.
    """
    from sklearn.base import clone

    from . import models as models_mod

    models = models_mod.make_models()
    if model_name not in models:
        raise SystemExit(f"unknown model '{model_name}'; available: {', '.join(models)}")

    if target == "position":
        y = [s.position or "(unspecified)" for s in dataset.samples]
    elif target == "label":
        y = dataset.labels
    else:
        raise SystemExit("target must be 'position' or 'label'")
    if len(set(y)) < 2:
        raise SystemExit(f"need >=2 distinct {target} values to train; got {sorted(set(y))}")

    est = clone(models[model_name])
    est.fit(dataset.x, y)
    classes = [str(c) for c in est.classes_]

    if target == "position":
        zones = {c: dict(dataset.position_coords.get(c, {"x": None, "y": None})) for c in classes}
    else:
        zones = {c: {"x": None, "y": None} for c in classes}

    return {
        "format": BUNDLE_FORMAT,
        "model": est,
        "classes": classes,
        "target": target,
        "model_name": model_name,
        "feature": feature,
        "imag_first": True,
        "window": int(window),
        "step": int(step),
        "n_features": int(dataset.x.shape[1]),
        "zones": zones,
    }


def save_bundle(bundle: dict, path: str) -> None:
    import joblib

    joblib.dump(bundle, path)


def load_bundle(path: str) -> dict:
    import joblib

    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or bundle.get("format") != BUNDLE_FORMAT:
        raise SystemExit(f"not an rfsense live-model bundle ({BUNDLE_FORMAT}): {path}")
    return bundle


class LiveEstimator:
    """Turns the most recent CSI window into a state dict for the web view.

    With a bundle it runs the trained classifier; without one it uses an adaptive motion heuristic
    that tracks a quiet-floor baseline and flags occupancy when motion rises clearly above it.
    """

    def __init__(
        self,
        bundle: dict | None = None,
        *,
        window: int = 64,
        motion_threshold: float | None = None,
        baseline_alpha: float = 0.05,
        baseline_k: float = 3.0,
    ) -> None:
        self.bundle = bundle
        if bundle is not None:
            self.window = int(bundle.get("window", window))
            self.feature = str(bundle.get("feature", "amplitude"))
            self.classes = [str(c) for c in bundle.get("classes", [])]
            self.target = str(bundle.get("target", "label"))
            self.zones = dict(bundle.get("zones", {}))
            self._n_features = int(bundle.get("n_features", 0))
            self._model = bundle["model"]
            self._has_proba = hasattr(self._model, "predict_proba")
        else:
            self.window = int(window)
            self.feature = "amplitude"
            self.classes = ["empty", "occupied"]
            self.target = "presence"
            self.zones = {"empty": {"x": None, "y": None}, "occupied": {"x": None, "y": None}}
            self._n_features = 0
            self._model = None
            self._has_proba = False

        self.motion_threshold = motion_threshold
        self.baseline_alpha = baseline_alpha
        self.baseline_k = baseline_k
        self._base_mean: float | None = None
        self._base_var: float = 0.0
        self._baseline_samples = 0

    @property
    def mode(self) -> str:
        return "model" if self._model is not None else "heuristic"

    def predict_complex(self, csi_matrix: np.ndarray) -> dict:
        """csi_matrix: complex (n_frames, n_subcarriers). Uses the most recent `window` frames."""
        if csi_matrix.size == 0 or csi_matrix.shape[0] < 2:
            return {"ready": False, "reason": "waiting for frames", "mode": self.mode}

        block_c = csi_matrix[-self.window :]
        block = csi_mod.sanitize_phase(block_c) if self.feature == "phase" else np.abs(block_c)
        motion = float(np.abs(np.diff(block, axis=0)).mean())

        if self._model is not None:
            return self._predict_model(block, motion)
        return self._predict_heuristic(motion)

    def _predict_model(self, block: np.ndarray, motion: float) -> dict:
        try:
            feats = feat_mod.window_features(block).reshape(1, -1)
        except ValueError as exc:
            return {"ready": False, "reason": str(exc), "mode": "model"}
        if self._n_features and feats.shape[1] != self._n_features:
            return {
                "ready": False,
                "mode": "model",
                "reason": (
                    f"subcarrier mismatch: live window has {feats.shape[1]} features, "
                    f"model expects {self._n_features} (different channel/bandwidth?)"
                ),
            }
        try:
            if self._has_proba:
                proba = self._model.predict_proba(feats)[0]
                order = list(self._model.classes_)
                idx = int(np.argmax(proba))
                state = str(order[idx])
                confidence = float(proba[idx])
                scores = {str(c): float(p) for c, p in zip(order, proba, strict=True)}
            else:
                state = str(self._model.predict(feats)[0])
                confidence = 1.0
                scores = {state: 1.0}
        except Exception as exc:  # noqa: BLE001 - surface any sklearn error to the UI, don't crash the loop
            return {"ready": False, "mode": "model", "reason": f"prediction failed: {exc}"}
        return {
            "ready": True,
            "mode": "model",
            "target": self.target,
            "state": state,
            "confidence": confidence,
            "motion": motion,
            "scores": scores,
        }

    def _predict_heuristic(self, motion: float) -> dict:
        if self.motion_threshold is not None:
            occupied = motion > self.motion_threshold
            # Confidence scales with how far past the threshold we are.
            confidence = float(np.clip(motion / (self.motion_threshold + 1e-9), 0.0, 1.0))
            if occupied:
                confidence = float(np.clip(motion / (2 * self.motion_threshold + 1e-9), 0.5, 1.0))
        else:
            if self._base_mean is None:
                self._base_mean = motion
            self._baseline_samples += 1
            std = float(np.sqrt(self._base_var)) if self._base_var > 0 else 0.0
            z = (motion - self._base_mean) / std if std > 0 else 0.0
            meaningful_rise = motion > max(self._base_mean * 2.0, self._base_mean + 1e-6)
            occupied = self._baseline_samples > 10 and z > self.baseline_k and meaningful_rise
            confidence = float(1.0 / (1.0 + np.exp(-(z - self.baseline_k))))
            # Track the quiet-floor baseline only while it looks empty, so a person standing in the
            # link does not get absorbed into the baseline.
            if not occupied:
                a = self.baseline_alpha
                delta = motion - self._base_mean
                self._base_mean += a * delta
                self._base_var = (1 - a) * (self._base_var + a * delta * delta)

        state = "occupied" if occupied else "empty"
        state_confidence = confidence if occupied else 1 - confidence
        return {
            "ready": True,
            "mode": "heuristic",
            "target": "presence",
            "state": state,
            "confidence": state_confidence,
            "motion": motion,
            "scores": {
                "occupied": confidence,
                "empty": 1 - confidence,
            },
        }
