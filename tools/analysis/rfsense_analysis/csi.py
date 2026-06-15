"""Convert raw CSI bytes to complex subcarriers and derive amplitude/phase.

The ESP32 reports each subcarrier as two signed bytes in (imaginary, real) order. We expose the
byte order as a parameter rather than hard-coding it, because it is the kind of convention that is
easy to get wrong and worth testing explicitly. Raw bytes are interpreted, never modified.

Phase from a single RF link is corrupted by carrier/sampling frequency offsets that appear as a
(largely linear) ramp across subcarriers plus a constant offset. `sanitize_phase` removes that
linear component per frame -- the standard first-order calibration. It is deliberately simple and
documented as such: it does not recover true absolute phase, only a stabilized relative phase.
"""

from __future__ import annotations

import numpy as np

# Subcarriers a frame's CSI byte count must be a multiple of (2 bytes per complex sample).
BYTES_PER_SUBCARRIER = 2


def raw_to_complex(csi: bytes, *, imag_first: bool = True) -> np.ndarray:
    """Decode raw CSI bytes into a 1-D complex array (one entry per subcarrier)."""
    arr = np.frombuffer(csi, dtype=np.int8)
    if arr.size % BYTES_PER_SUBCARRIER != 0:
        arr = arr[: arr.size - (arr.size % BYTES_PER_SUBCARRIER)]
    pairs = arr.reshape(-1, 2).astype(np.float64)
    if imag_first:
        imag, real = pairs[:, 0], pairs[:, 1]
    else:
        real, imag = pairs[:, 0], pairs[:, 1]
    return real + 1j * imag


def frames_to_matrix(
    frames,
    *,
    imag_first: bool = True,
    drop_invalid_first_word: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Stack frames sharing the dominant subcarrier count into a complex matrix.

    Returns (timestamps_us, csi_matrix) where csi_matrix has shape (n_frames, n_subcarriers).
    Frames whose CSI length differs from the mode are skipped so the matrix is rectangular; this
    is reported by the caller via the returned row count, not silently hidden.
    """
    decoded: list[tuple[int, np.ndarray]] = []
    for f in frames:
        if not f.csi:
            continue
        raw = f.csi
        if drop_invalid_first_word and getattr(f, "first_word_invalid", 0):
            # ESP-IDF's flag invalidates only the first four CSI bytes (two complex samples),
            # not the whole frame. Classic ESP32 commonly sets this flag on every frame.
            raw = raw[4:]
        if not raw:
            continue
        z = raw_to_complex(raw, imag_first=imag_first)
        decoded.append((f.timestamp_us, z))
    if not decoded:
        return np.empty(0, dtype=np.int64), np.empty((0, 0), dtype=np.complex128)

    lengths = np.array([z.size for _, z in decoded])
    dominant = int(np.bincount(lengths).argmax())
    kept = [(ts, z) for ts, z in decoded if z.size == dominant]
    timestamps = np.array([ts for ts, _ in kept], dtype=np.int64)
    matrix = (
        np.vstack([z for _, z in kept]) if kept else np.empty((0, dominant), dtype=np.complex128)
    )
    return timestamps, matrix


def amplitude(csi_matrix: np.ndarray) -> np.ndarray:
    return np.abs(csi_matrix)


def phase(csi_matrix: np.ndarray) -> np.ndarray:
    return np.angle(csi_matrix)


def sanitize_phase(csi_matrix: np.ndarray) -> np.ndarray:
    """Remove the per-frame linear phase ramp (CFO/SFO) and constant offset across subcarriers.

    For each frame we unwrap phase over subcarrier index k, fit phase ~= a*k + b by least squares,
    and subtract the fit. The result is a stabilized relative phase suitable for feature
    extraction; it is NOT a recovery of absolute channel phase.
    """
    if csi_matrix.size == 0:
        return csi_matrix.real.copy()
    ph = np.unwrap(np.angle(csi_matrix), axis=1)
    n_sub = ph.shape[1]
    k = np.arange(n_sub, dtype=np.float64)
    kc = k - k.mean()
    denom = np.sum(kc * kc)
    if denom == 0:
        return ph
    slope = (ph * kc).sum(axis=1) / denom
    intercept = ph.mean(axis=1) - slope * k.mean()
    fit = slope[:, None] * k[None, :] + intercept[:, None]
    return ph - fit


def subcarrier_quality(csi_matrix: np.ndarray) -> dict[str, np.ndarray]:
    """Per-subcarrier diagnostics to spot dead/saturated/noisy subcarriers before modeling."""
    if csi_matrix.size == 0:
        empty = np.empty(0)
        return {
            "mean_amplitude": empty,
            "std_amplitude": empty,
            "dynamic_range": empty,
            "zero_fraction": empty,
        }
    amp = np.abs(csi_matrix)
    mean_amp = amp.mean(axis=0)
    std_amp = amp.std(axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        dynamic_range = np.where(mean_amp > 0, std_amp / mean_amp, 0.0)
    zero_fraction = (amp == 0).mean(axis=0)
    return {
        "mean_amplitude": mean_amp,
        "std_amplitude": std_amp,
        "dynamic_range": dynamic_range,
        "zero_fraction": zero_fraction,
    }
