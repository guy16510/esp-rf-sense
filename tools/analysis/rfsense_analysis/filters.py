"""Denoising filters applied per subcarrier over time (axis 0 = frames, axis 1 = subcarriers).

These are the classical CSI cleaning steps: a median filter for impulse noise, a Hampel filter for
robust outlier rejection, and a low-pass Butterworth for band-limiting slow human motion. None of
them are mandatory; they are tools the feature stage can compose. They never reorder or drop
frames -- output shape always matches input shape.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import butter, filtfilt


def median_time(matrix: np.ndarray, window: int = 5) -> np.ndarray:
    """Median filter along time, independently per subcarrier. `window` is forced odd."""
    if matrix.size == 0:
        return matrix.copy()
    w = window if window % 2 == 1 else window + 1
    return median_filter(matrix, size=(w, 1), mode="nearest")


def hampel(matrix: np.ndarray, window: int = 7, n_sigma: float = 3.0) -> np.ndarray:
    """Hampel outlier filter per subcarrier over time.

    Replaces samples that deviate from the local median by more than n_sigma robust standard
    deviations (1.4826 * MAD) with that median. Returns a filtered copy of the same shape.
    """
    if matrix.size == 0:
        return matrix.copy()
    w = window if window % 2 == 1 else window + 1
    out = matrix.astype(np.float64, copy=True)
    local_median = median_filter(out, size=(w, 1), mode="nearest")
    abs_dev = np.abs(out - local_median)
    mad = median_filter(abs_dev, size=(w, 1), mode="nearest")
    sigma = 1.4826 * mad
    threshold = n_sigma * sigma
    mask = ((threshold > 0) & (abs_dev > threshold)) | ((threshold == 0) & (abs_dev > 0))
    out[mask] = local_median[mask]
    return out


def butterworth_lowpass(
    matrix: np.ndarray,
    cutoff_hz: float,
    fs_hz: float,
    order: int = 4,
) -> np.ndarray:
    """Zero-phase low-pass Butterworth along time, per subcarrier.

    fs_hz is the CSI frame rate. Human motion is well below a few Hz, so a low cutoff suppresses
    measurement noise without smearing motion. Falls back to a no-op if the series is too short for
    the requested filter order (filtfilt needs enough samples).
    """
    if matrix.size == 0:
        return matrix.copy()
    nyquist = 0.5 * fs_hz
    wn = cutoff_hz / nyquist
    if not 0 < wn < 1:
        raise ValueError(
            f"cutoff_hz={cutoff_hz} invalid for fs_hz={fs_hz} (need 0 < cutoff < Nyquist)"
        )
    n = matrix.shape[0]
    padlen = 3 * order
    if n <= padlen:
        return matrix.astype(np.float64, copy=True)
    b, a = butter(order, wn, btype="low")
    return filtfilt(b, a, matrix, axis=0)
