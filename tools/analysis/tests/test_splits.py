import pytest

from rfsense_analysis.splits import (
    Sample,
    assert_no_recording_leakage,
    group_values,
    leave_one_group_out,
)


def _samples():
    # Two recordings per person, several windows each. Windows of one recording share provenance.
    samples = []
    spec = [
        ("rec-p1-a", "occupied", "p1", "posA", "2026-01-01"),
        ("rec-p1-b", "empty", "p1", "posB", "2026-01-01"),
        ("rec-p2-a", "occupied", "p2", "posA", "2026-01-02"),
        ("rec-p2-b", "empty", "p2", "posB", "2026-01-02"),
    ]
    for rec, label, person, pos, day in spec:
        for _ in range(5):  # 5 windows per recording
            samples.append(
                Sample(recording_id=rec, label=label, subject_id=person, position=pos, day=day)
            )
    return samples


def test_leave_one_person_out_holds_out_whole_person():
    samples = _samples()
    folds = list(leave_one_group_out(samples, "person"))
    assert len(folds) == 2  # p1, p2
    for train_idx, test_idx, held in folds:
        test_people = {samples[i].subject_id for i in test_idx}
        train_people = {samples[i].subject_id for i in train_idx}
        assert test_people == {held}
        assert held not in train_people


def test_no_recording_leakage_across_any_split():
    samples = _samples()
    for key in ("person", "position", "day", "recording"):
        for train_idx, test_idx, _ in leave_one_group_out(samples, key):
            # Should not raise.
            assert_no_recording_leakage(samples, train_idx, test_idx)


def test_leakage_guard_raises_on_overlap():
    samples = _samples()
    # Force an overlap: same recording index in both sets.
    with pytest.raises(AssertionError, match="leakage"):
        assert_no_recording_leakage(samples, [0, 1], [1, 2])


def test_leave_one_day_out():
    samples = _samples()
    days = {held for _, _, held in leave_one_group_out(samples, "day")}
    assert days == {"2026-01-01", "2026-01-02"}


def test_unknown_group_key():
    with pytest.raises(ValueError):
        group_values(_samples(), "altitude")
