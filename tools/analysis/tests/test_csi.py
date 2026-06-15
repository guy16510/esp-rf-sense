import numpy as np

from rfsense_analysis import csi as csi_mod


def test_raw_to_complex_imag_first():
    # bytes (imag, real) pairs: (2,1) -> 1 + 2j, (-1, 3) -> 3 - 1j
    raw = bytes([2, 1]) + (np.array([-1, 3], dtype=np.int8).tobytes())
    z = csi_mod.raw_to_complex(raw, imag_first=True)
    assert z[0] == 1 + 2j
    assert z[1] == 3 - 1j


def test_raw_to_complex_real_first_swaps():
    raw = np.array([1, 2], dtype=np.int8).tobytes()
    z_if = csi_mod.raw_to_complex(raw, imag_first=True)
    z_rf = csi_mod.raw_to_complex(raw, imag_first=False)
    assert z_if[0] == 2 + 1j
    assert z_rf[0] == 1 + 2j


def test_raw_to_complex_truncates_odd_length():
    z = csi_mod.raw_to_complex(bytes([1, 2, 3]), imag_first=True)
    assert z.size == 1


class _F:
    def __init__(self, ts, csi, first_word_invalid=0):
        self.timestamp_us = ts
        self.csi = csi
        self.first_word_invalid = first_word_invalid


def test_frames_to_matrix_keeps_dominant_length():
    frames = [
        _F(0, bytes([1, 1, 2, 2])),  # 2 subcarriers
        _F(1, bytes([3, 3, 4, 4])),  # 2 subcarriers
        _F(2, bytes([5, 5])),  # 1 subcarrier (minority -> dropped)
    ]
    ts, m = csi_mod.frames_to_matrix(frames)
    assert m.shape == (2, 2)
    assert ts.tolist() == [0, 1]


def test_frames_to_matrix_drops_invalid_first_word():
    frames = [_F(0, bytes([1, 1]), first_word_invalid=1), _F(1, bytes([2, 2]))]
    ts, m = csi_mod.frames_to_matrix(frames, drop_invalid_first_word=True)
    assert m.shape == (1, 1)


def test_sanitize_phase_removes_linear_ramp():
    # A pure linear phase ramp across subcarriers should be flattened to ~0.
    k = np.arange(16)
    ramp = np.exp(1j * (0.3 * k + 0.5))
    matrix = np.vstack([ramp, ramp * np.exp(1j * 0.1)])
    sanitized = csi_mod.sanitize_phase(matrix)
    assert np.allclose(sanitized, 0, atol=1e-6)


def test_subcarrier_quality_flags_dead_subcarrier():
    matrix = np.array([[1 + 0j, 0 + 0j], [2 + 0j, 0 + 0j], [3 + 0j, 0 + 0j]])
    q = csi_mod.subcarrier_quality(matrix)
    assert q["zero_fraction"][1] == 1.0
    assert q["zero_fraction"][0] == 0.0
