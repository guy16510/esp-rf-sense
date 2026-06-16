"""Train richer display targets without changing the proven live estimator implementation."""

from __future__ import annotations

from .dataset import LoadedDataset
from .livemodel import BUNDLE_FORMAT
from .scene import semantics_for_target

SUPPORTED_TARGETS = {"position", "label", "count", "movement", "orientation", "pose", "kind"}


def train_scene_model(
    dataset: LoadedDataset,
    *,
    target: str,
    model_name: str,
    window: int,
    step: int,
    feature: str,
) -> dict:
    """Fit a live-display classifier for a scene attribute.

    The returned bundle remains compatible with ``LiveEstimator``. Extra class semantics are
    consumed by the dashboard when available, while target-specific class names remain sufficient
    for count, pose, movement, orientation, and position rendering.
    """

    from sklearn.base import clone

    from . import models as models_mod

    normalized_target = target.lower().replace("-", "_")
    if normalized_target not in SUPPORTED_TARGETS:
        raise SystemExit(f"target must be one of {', '.join(sorted(SUPPORTED_TARGETS))}")

    models = models_mod.make_models()
    if model_name not in models:
        raise SystemExit(f"unknown model '{model_name}'; available: {', '.join(models)}")

    x, y = dataset.target_table(normalized_target)
    if len(set(y)) < 2:
        raise SystemExit(
            f"need >=2 distinct {normalized_target} values to train; got {sorted(set(y))}"
        )

    estimator = clone(models[model_name])
    estimator.fit(x, y)
    classes = [str(value) for value in estimator.classes_]
    zones = (
        {value: dict(dataset.position_coords.get(value, {"x": None, "y": None})) for value in classes}
        if normalized_target == "position"
        else {value: {"x": None, "y": None} for value in classes}
    )
    return {
        "format": BUNDLE_FORMAT,
        "model": estimator,
        "classes": classes,
        "target": normalized_target,
        "model_name": model_name,
        "feature": feature,
        "imag_first": True,
        "window": int(window),
        "step": int(step),
        "n_features": int(x.shape[1]),
        "zones": zones,
        "class_semantics": {
            value: semantics_for_target(normalized_target, value) for value in classes
        },
    }
