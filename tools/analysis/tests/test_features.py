import numpy as np

from rfsense_analysis import features as feat


def test_sliding_windows_counts():
    w = feat.sliding_windows(n_frames=100, window=20, step=10)
    assert w[0].start == 0
    assert w[-1].start == 80
    assert len(w) == 9


def test_sliding_windows_empty_when_too_short():
    assert feat.sliding_windows(n_frames=10, window=20, step=5) == []


def test_window_features_dimension_and_motion():
    n_sub = 8
    still = np.ones((32, n_sub))
    moving = np.cumsum(np.ones((32, n_sub)), axis=0).astype(float)
    f_still = feat.window_features(still)
    f_moving = feat.window_features(moving)
    # 2*n_sub (mean+std) + 6 aggregate features
    assert f_still.size == 2 * n_sub + 6
    # The motion proxy (mean abs first-diff) is the 2*n_sub-th feature.
    motion_idx = 2 * n_sub
    assert f_moving[motion_idx] > f_still[motion_idx]


def test_build_feature_table_rows_match_windows():
    matrix = np.random.default_rng(0).standard_normal((200, 6))
    x, windows = feat.build_feature_table(matrix, window=50, step=25)
    assert x.shape[0] == len(windows)
    assert x.shape[1] == 2 * 6 + 6


def test_doppler_stft_shapes():
    fs = 50.0
    t = np.arange(0, 8, 1 / fs)
    series = np.sin(2 * np.pi * 2.0 * t)
    f, times, mag = feat.doppler_stft(series, fs_hz=fs, nperseg=64)
    assert mag.shape == (f.size, times.size)
    # Energy should peak near 2 Hz.
    peak_freq = f[np.argmax(mag.mean(axis=1))]
    assert abs(peak_freq - 2.0) < 2.0


def test_change_points_detects_step():
    series = np.concatenate([np.ones(100) * 0.01, np.ones(100) * 5.0])
    # Inject tiny noise so the trailing-window std is non-zero before the step.
    rng = np.random.default_rng(1)
    series = series + 0.001 * rng.standard_normal(series.size)
    cps = feat.change_points(series, window=32, n_sigma=4.0)
    assert any(95 <= c <= 140 for c in cps)
