"""Classical baseline classifiers and honest, group-aware evaluation.

Deliberately classical and interpretable: logistic regression, random forest, gradient boosting,
and an RBF SVM, each wrapped with feature standardization. No deep learning. Evaluation uses the
leave-one-{person,position,day}-out splits from `splits`, and every report includes a
majority-class baseline so a model that has merely learned the class prior is exposed rather than
celebrated.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from .splits import GroupKey, Sample, leave_one_group_out


def make_models() -> dict[str, object]:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.svm import SVC

    def pipe(clf: object) -> object:
        return Pipeline([("scale", StandardScaler()), ("clf", clf)])

    return {
        "logistic_regression": pipe(LogisticRegression(max_iter=2000, class_weight="balanced")),
        "random_forest": RandomForestClassifier(
            n_estimators=300, class_weight="balanced", random_state=0
        ),
        "gradient_boosting": GradientBoostingClassifier(random_state=0),
        "svm_rbf": pipe(SVC(kernel="rbf", class_weight="balanced", random_state=0)),
    }


@dataclass
class FoldResult:
    held_out: str
    n_train: int
    n_test: int
    accuracy: float
    balanced_accuracy: float
    macro_f1: float
    majority_baseline: float


@dataclass
class EvaluationReport:
    model_name: str
    group_key: GroupKey
    folds: list[FoldResult] = field(default_factory=list)

    @property
    def mean_accuracy(self) -> float:
        return float(np.mean([f.accuracy for f in self.folds])) if self.folds else 0.0

    @property
    def mean_balanced_accuracy(self) -> float:
        return float(np.mean([f.balanced_accuracy for f in self.folds])) if self.folds else 0.0

    @property
    def mean_macro_f1(self) -> float:
        return float(np.mean([f.macro_f1 for f in self.folds])) if self.folds else 0.0

    @property
    def mean_majority_baseline(self) -> float:
        return float(np.mean([f.majority_baseline for f in self.folds])) if self.folds else 0.0

    def summary(self) -> str:
        lift = self.mean_balanced_accuracy - 0.5
        return (
            f"{self.model_name} | leave-one-{self.group_key}-out | "
            f"acc={self.mean_accuracy:.3f} bal_acc={self.mean_balanced_accuracy:.3f} "
            f"macroF1={self.mean_macro_f1:.3f} majority={self.mean_majority_baseline:.3f} "
            f"(bal_acc lift over chance={lift:+.3f}) over {len(self.folds)} fold(s)"
        )


def evaluate_group_cv(
    x: np.ndarray,
    y: Sequence[str],
    samples: Sequence[Sample],
    *,
    group_key: GroupKey,
    model_name: str,
    model: object,
) -> EvaluationReport:
    from sklearn.base import clone
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score

    y_arr = np.asarray(y)
    report = EvaluationReport(model_name=model_name, group_key=group_key)
    for train_idx, test_idx, held in leave_one_group_out(samples, group_key):
        x_tr, x_te = x[train_idx], x[test_idx]
        y_tr, y_te = y_arr[train_idx], y_arr[test_idx]
        if len(set(y_tr)) < 2:
            # Can't train a classifier on a single class; skip but keep the fold count honest.
            continue
        est = clone(model)
        est.fit(x_tr, y_tr)
        pred = est.predict(x_te)
        # Majority-class baseline computed from the TRAIN labels (no peeking at test).
        values, counts = np.unique(y_tr, return_counts=True)
        majority_label = values[int(counts.argmax())]
        majority = float(np.mean(y_te == majority_label))
        report.folds.append(
            FoldResult(
                held_out=held,
                n_train=len(train_idx),
                n_test=len(test_idx),
                accuracy=float(accuracy_score(y_te, pred)),
                balanced_accuracy=float(balanced_accuracy_score(y_te, pred)),
                macro_f1=float(f1_score(y_te, pred, average="macro", zero_division=0)),
                majority_baseline=majority,
            )
        )
    return report
