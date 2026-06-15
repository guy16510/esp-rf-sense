import numpy as np
import pytest

pytest.importorskip("sklearn")

from rfsense_analysis import models as models_mod  # noqa: E402
from rfsense_analysis.splits import Sample  # noqa: E402


def _separable_dataset():
    """Two classes, two people per class, windows grouped by recording. Class is linearly separable
    so a working pipeline + honest split should beat the majority baseline."""
    rng = np.random.default_rng(0)
    x_blocks = []
    samples = []
    # (recording_id, label, person)
    spec = [
        ("rec-empty-p1", "empty", "p1", 0.0),
        ("rec-empty-p2", "empty", "p2", 0.0),
        ("rec-occ-p3", "occupied", "p3", 4.0),
        ("rec-occ-p4", "occupied", "p4", 4.0),
    ]
    for rec, label, person, center in spec:
        block = center + rng.standard_normal((20, 5))
        x_blocks.append(block)
        samples.extend(
            [Sample(recording_id=rec, label=label, subject_id=person, day="2026-01-01")] * 20
        )
    return np.vstack(x_blocks), [s.label for s in samples], samples


def test_make_models_has_no_deep_learning():
    names = set(models_mod.make_models())
    assert names == {"logistic_regression", "random_forest", "gradient_boosting", "svm_rbf"}


def test_evaluate_group_cv_beats_majority_on_separable_data():
    x, y, samples = _separable_dataset()
    model = models_mod.make_models()["logistic_regression"]
    report = models_mod.evaluate_group_cv(
        x, y, samples, group_key="person", model_name="logistic_regression", model=model
    )
    assert len(report.folds) == 4  # leave-one-person-out
    assert report.mean_balanced_accuracy > report.mean_majority_baseline
    assert "leave-one-person-out" in report.summary()


def test_evaluate_records_train_test_sizes():
    x, y, samples = _separable_dataset()
    model = models_mod.make_models()["random_forest"]
    report = models_mod.evaluate_group_cv(
        x, y, samples, group_key="recording", model_name="random_forest", model=model
    )
    for fold in report.folds:
        assert fold.n_test == 20
        assert fold.n_train == 60
