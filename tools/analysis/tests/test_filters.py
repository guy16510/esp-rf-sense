import numpy as np

from rfsense_analysis import filters


def test_median_time_removes_single_spike():
    col = np.array([1.0, 1.0, 50.0, 1.0, 1.0])
    out = filters.median_time(col.reshape(-1, 1), window=3)
    assert out[2, 0] == 1.0
    assert out.shape == (5, 1)


def test_hampel_replaces_outlier_with_local_median():
    series = np.ones((21, 1))
    series[10, 0] = 100.0
    out = filters.hampel(series, window=7, n_sigma=3.0)
    assert abs(out[10, 0] - 1.0) < 1e-9
    # Non-outliers are untouched.
    assert np.allclose(out[:10], 1.0)


def test_hampel_preserves_shape_and_clean_signal():
    rng = np.random.default_rng(0)
    clean = np.ones((50, 4)) + 0.001 * rng.standard_normal((50, 4))
    out = filters.hampel(clean, window=7, n_sigma=5.0)
    assert out.shape == clean.shape
    assert np.allclose(out, clean, atol=0.01)


def test_butterworth_attenuates_high_frequency():
    fs = 100.0
    t = np.arange(0, 4, 1 / fs)
    low = np.sin(2 * np.pi * 1.0 * t)
    high = 0.5 * np.sin(2 * np.pi * 30.0 * t)
    sig = (low + high).reshape(-1, 1)
    out = filters.butterworth_lowpass(sig, cutoff_hz=5.0, fs_hz=fs, order=4)
    # The 30 Hz component should be strongly suppressed -> output close to the 1 Hz component.
    err = np.sqrt(np.mean((out[:, 0] - low) ** 2))
    assert err < 0.15


def test_butterworth_noop_on_short_series():
    sig = np.ones((5, 2))
    out = filters.butterworth_lowpass(sig, cutoff_hz=5.0, fs_hz=100.0, order=4)
    assert out.shape == sig.shape
