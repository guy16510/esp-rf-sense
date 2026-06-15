"""Group-aware cross-validation splits.

Device-free sensing generalization is easy to overstate. Two failure modes are guarded here:

1. Window leakage: adjacent windows from one recording are nearly identical. If some land in train
   and some in test, a model "predicts" by memorizing the recording, not the phenomenon. We keep
   every window of a recording in the same fold.

2. Subject/position/day leakage: to claim the model generalizes to a NEW person, position, or day,
   that person/position/day must be entirely held out. We provide leave-one-{person,position,day}
   -out splits built on those grouping keys.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Sample:
    """One feature row's provenance. `recording_id` ties windows of one recording together."""

    recording_id: str
    label: str
    subject_id: str = ""  # "" for empty-room baselines
    position: str = ""
    day: str = ""


GroupKey = str  # "person" | "position" | "day" | "recording"


def group_values(samples: Sequence[Sample], key: GroupKey) -> list[str]:
    if key == "person":
        return [s.subject_id for s in samples]
    if key == "position":
        return [s.position for s in samples]
    if key == "day":
        return [s.day for s in samples]
    if key == "recording":
        return [s.recording_id for s in samples]
    raise ValueError(f"unknown group key: {key}")


def leave_one_group_out(
    samples: Sequence[Sample],
    key: GroupKey,
) -> Iterator[tuple[list[int], list[int], str]]:
    """Yield (train_idx, test_idx, held_out_group) holding out one group value at a time.

    Recording integrity is enforced regardless of `key`: because every window of a recording shares
    the same subject/position/day (and recording_id), holding out a group value never splits a
    recording. For key="recording" this is leave-one-recording-out directly.
    """
    values = group_values(samples, key)
    unique = sorted({v for v in values if v != ""})
    if not unique:
        raise ValueError(f"no non-empty values for group key '{key}'")
    for held in unique:
        test_idx = [i for i, v in enumerate(values) if v == held]
        train_idx = [i for i, v in enumerate(values) if v != held]
        if not train_idx or not test_idx:
            continue
        assert_no_recording_leakage(samples, train_idx, test_idx)
        yield train_idx, test_idx, held


def assert_no_recording_leakage(
    samples: Sequence[Sample],
    train_idx: Sequence[int],
    test_idx: Sequence[int],
) -> None:
    """Raise if any recording_id appears in both the train and test index sets."""
    train_recordings = {samples[i].recording_id for i in train_idx}
    test_recordings = {samples[i].recording_id for i in test_idx}
    overlap = train_recordings & test_recordings
    if overlap:
        raise AssertionError(
            f"window leakage: recordings in both train and test: {sorted(overlap)}"
        )
