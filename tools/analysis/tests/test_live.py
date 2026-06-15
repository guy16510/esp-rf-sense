import numpy as np
import pytest

from rfsense_analysis import features as feat_mod
from rfsense_analysis import protocol as proto
from rfsense_analysis.dataset import LoadedDataset
from rfsense_analysis.live import InteractiveTrainer, LiveBuffer
from rfsense_analysis.livemodel import LiveEstimator
from rfsense_analysis.splits import Sample


def _still_block(frames: int, subs: int) -> np.ndarray:
    """A near-constant complex window: barely any frame-to-frame change."""
    base = (np.arange(subs) + 1).astype(np.float64)
    return np.tile(base, (frames, 1)).astype(np.complex128)


def _moving_block(frames: int, subs: int, amp: float = 8.0) -> np.ndarray:
    """A complex window with large frame-to-frame swings (motion)."""
    rng = np.random.default_rng(0)
    real = amp * rng.standard_normal((frames, subs))
    imag = amp * rng.standard_normal((frames, subs))
    return real + 1j * imag


def test_heuristic_fixed_threshold_distinguishes_still_from_moving():
    est = LiveEstimator(window=16, motion_threshold=1.0)
    still = est.predict_complex(_still_block(16, 8))
    moving = est.predict_complex(_moving_block(16, 8))
    assert still["mode"] == "heuristic"
    assert still["state"] == "empty"
    assert still["confidence"] > 0.9
    assert moving["state"] == "occupied"
    assert moving["motion"] > still["motion"]


def test_heuristic_adaptive_baseline_flags_motion_after_quiet():
    est = LiveEstimator(window=16, baseline_k=3.0)
    # Feed several quiet windows so the baseline settles on the floor.
    for _ in range(20):
        quiet = est.predict_complex(_still_block(16, 8) + 0.01 * np.random.standard_normal((16, 8)))
        assert quiet["state"] == "empty"
    spike = est.predict_complex(_moving_block(16, 8))
    assert spike["state"] == "occupied"
    assert spike["confidence"] >= 0.5


def test_predict_waits_for_frames():
    est = LiveEstimator(window=16)
    assert est.predict_complex(np.empty((0, 0), dtype=np.complex128))["ready"] is False
    assert est.predict_complex(np.ones((1, 8), dtype=np.complex128))["ready"] is False


def test_live_buffer_counts_gaps_and_snapshots():
    buf = LiveBuffer(max_frames=64)

    def dg(packet_seq: int, frame_seq: int) -> proto.Datagram:
        header = proto.DatagramHeader(
            protocol_version=proto.PROTOCOL_VERSION,
            device_id=0xABCD,
            boot_id=1,
            packet_seq=packet_seq,
            batch_seq=0,
            flags=0,
            capture_mode=0,
            frame_count=1,
            payload_len=0,
        )
        frame = proto.Frame(
            frame_seq=frame_seq,
            timestamp_us=frame_seq * 1000,
            ping_seq=proto.PING_SEQ_NONE,
            rssi=-40,
            noise_floor=-90,
            channel=6,
            secondary_channel=0,
            bandwidth=0,
            phy_mode=0,
            rate=0,
            first_word_invalid=0,
            link_id=0,
            csi=bytes([1, 2, 3, 4, 5, 6, 7, 8]),
        )
        return proto.Datagram(header=header, frames=[frame])

    buf.add_datagram(dg(0, 0))
    buf.add_datagram(dg(2, 1))  # skipped packet_seq 1 -> one gap
    _ts, matrix, stats = buf.snapshot()
    assert stats["gaps"] == 1
    assert stats["datagrams"] == 2
    assert matrix.shape[0] == 2


def test_interactive_trainer_collects_labels_and_trains():
    pytest.importorskip("sklearn")
    trainer = InteractiveTrainer(LiveEstimator(window=16))
    trainer.start("empty")
    for index in range(5):
        trainer.collect(_still_block(16, 8) + index * 0.001, index)
    trainer.start("moving")
    for index in range(5, 10):
        trainer.collect(_moving_block(16, 8, amp=float(index)), index)

    assert trainer.status()["counts"] == {"empty": 5, "moving": 5}
    trainer.train()
    status = trainer.status()
    assert status["mode"] == "model"
    assert set(status["classes"]) == {"empty", "moving"}
    assert trainer.predict(_moving_block(16, 8))["ready"] is True


def _synthetic_dataset(window: int, subs: int) -> LoadedDataset:
    """Two coarse zones whose amplitude windows are linearly separable; windows grouped per session."""
    rng = np.random.default_rng(1)
    x_blocks, samples = [], []
    coords = {"deskA": {"x": 0.0, "y": 0.0}, "deskB": {"x": 3.0, "y": 0.0}}
    spec = [
        ("s-a1", "deskA", 1.0),
        ("s-a2", "deskA", 1.0),
        ("s-b1", "deskB", 9.0),
        ("s-b2", "deskB", 9.0),
    ]
    for sid, pos, center in spec:
        matrix = center + rng.standard_normal((window * 4, subs))
        x, _w = feat_mod.build_feature_table(matrix, window=window, step=window)
        x_blocks.append(x)
        samples.extend(
            [
                Sample(
                    recording_id=sid,
                    label="occupied",
                    subject_id="p",
                    position=pos,
                    day="2026-01-01",
                )
            ]
            * x.shape[0]
        )
    return LoadedDataset(
        x=np.vstack(x_blocks),
        samples=samples,
        position_coords=coords,
        n_sessions=len(spec),
    )


def test_train_save_load_predict_round_trip(tmp_path):
    pytest.importorskip("sklearn")
    pytest.importorskip("joblib")
    from rfsense_analysis import livemodel

    window, subs = 16, 8
    ds = _synthetic_dataset(window, subs)
    bundle = livemodel.train_model(
        ds, target="position", model_name="random_forest", window=window, step=window
    )
    assert bundle["format"] == livemodel.BUNDLE_FORMAT
    assert set(bundle["classes"]) == {"deskA", "deskB"}
    assert bundle["zones"]["deskA"] == {"x": 0.0, "y": 0.0}

    path = tmp_path / "live.joblib"
    livemodel.save_bundle(bundle, str(path))
    reloaded = livemodel.load_bundle(str(path))
    est = LiveEstimator(reloaded, window=window)
    assert est.mode == "model"

    result = est.predict_complex(_moving_block(window, subs))
    assert result["ready"] is True
    assert result["mode"] == "model"
    assert result["state"] in {"deskA", "deskB"}
    assert pytest.approx(sum(result["scores"].values()), rel=1e-6) == 1.0


def test_subcarrier_mismatch_is_reported_not_raised():
    pytest.importorskip("sklearn")
    pytest.importorskip("joblib")
    from rfsense_analysis import livemodel

    window = 16
    ds = _synthetic_dataset(window, 8)
    bundle = livemodel.train_model(
        ds, target="position", model_name="random_forest", window=window, step=window
    )
    est = LiveEstimator(bundle, window=window)
    # A window with a different subcarrier count must not crash the loop.
    result = est.predict_complex(_moving_block(window, 12))
    assert result["ready"] is False
    assert "subcarrier mismatch" in result["reason"]
