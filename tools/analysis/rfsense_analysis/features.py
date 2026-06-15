"""Feature extraction from a (frames x subcarriers) amplitude (or sanitized-phase) matrix.

Windows are the unit of classification. Each window produces one feature vector summarizing the
statistics and short-time dynamics of the CSI within it. Crucially, every window also carries the
identity of the recording it came from so the cross-validation in `splits` can keep all windows of
one recording together -- adjacent windows are highly correlated and must never straddle the
train/test boundary, or the reported accuracy is meaningless.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import stft


@dataclass(frozen=True)
class Window:
    start: int  # index of the first frame in the source matrix
    length: int


def sliding_windows(n_frames: int, window: int, step: int) -> list[Window]:
    if window <= 0 or step <= 0:
        raise ValueError("window and step must be positive")
    return [Window(start=s, length=window) for s in range(0, max(0, n_frames - window + 1), step)]


def window_features(block: np.ndarray) -> np.ndarray:
    """Summarize one window (block: window_len x n_subcarriers) into a fixed-length feature vector.

    Features are intentionally interpretable and link-agnostic:
      - per-subcarrier temporal mean and std (the bulk of the vector)
      - aggregate dispersion: mean/median/max of per-subcarrier std (overall "activity")
      - mean first-difference magnitude (a simple motion / Doppler-energy proxy)
      - cross-subcarrier correlation summary (how coherently subcarriers move together)
    """
    if block.ndim != 2 or block.shape[0] < 2:
        raise ValueError("window block must be 2-D with at least 2 frames")
    mean_sc = block.mean(axis=0)
    std_sc = block.std(axis=0)
    diff = np.abs(np.diff(block, axis=0))
    motion = diff.mean()
    motion_peak = diff.max()
    activity_mean = std_sc.mean()
    activity_median = float(np.median(std_sc))
    activity_max = std_sc.max()
    # Average pairwise correlation across subcarriers (coherent motion vs. noise).
    if block.shape[1] > 1 and np.all(std_sc > 0):
        corr = np.corrcoef(block.T)
        iu = np.triu_indices_from(corr, k=1)
        coherence = float(np.nanmean(corr[iu]))
    else:
        coherence = 0.0
    return np.concatenate(
        [
            mean_sc,
            std_sc,
            np.array(
                [motion, motion_peak, activity_mean, activity_median, activity_max, coherence]
            ),
        ]
    )


def build_feature_table(
    matrix: np.ndarray,
    *,
    window: int,
    step: int,
) -> tuple[np.ndarray, list[Window]]:
    """Turn a per-recording matrix into (X, windows). X has one row per window."""
    windows = sliding_windows(matrix.shape[0], window, step)
    if not windows:
        return np.empty((0, 0)), []
    rows = [window_features(matrix[w.start : w.start + w.length]) for w in windows]
    return np.vstack(rows), windows


def pca_reduce(x: np.ndarray, n_components: int) -> tuple[np.ndarray, object]:
    """Fit PCA and return (transformed, fitted_pca). Import is local so the module loads without
    scikit-learn present for callers that only need DSP."""
    from sklearn.decomposition import PCA

    k = min(n_components, x.shape[0], x.shape[1]) if x.size else 0
    pca = PCA(n_components=k)
    return (pca.fit_transform(x) if k > 0 else x), pca


def doppler_stft(
    series: np.ndarray,
    fs_hz: float,
    nperseg: int = 64,
    noverlap: int | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Short-time Fourier transform of a 1-D activity series (e.g. mean amplitude or PC1 over time).

    Returns (frequencies, times, magnitude) suitable for a Doppler-style spectrogram. This is a
    visualization/analysis aid; no claim is made that the resulting Doppler signature is calibrated.
    """
    series = np.asarray(series, dtype=np.float64).ravel()
    nperseg = min(nperseg, series.size) if series.size else 1
    f, t, zxx = stft(series, fs=fs_hz, nperseg=nperseg, noverlap=noverlap)
    return f, t, np.abs(zxx)


def change_points(series: np.ndarray, window: int = 32, n_sigma: float = 4.0) -> list[int]:
    """Detect abrupt changes in a 1-D activity series via a sliding-baseline z-score.

    A point is flagged when its value deviates from the trailing-window mean by more than n_sigma
    trailing-window standard deviations. Returns the flagged indices. Simple and transparent --
    meant as a first pass to segment a recording, not a statistically optimal detector.
    """
    series = np.asarray(series, dtype=np.float64).ravel()
    n = series.size
    if n <= window:
        return []
    flagged: list[int] = []
    for i in range(window, n):
        ref = series[i - window : i]
        mu = ref.mean()
        sd = ref.std()
        if sd > 0 and abs(series[i] - mu) > n_sigma * sd:
            flagged.append(i)
    return flagged
