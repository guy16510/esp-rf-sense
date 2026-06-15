"""Offline analysis for ESP32-S3 Wi-Fi CSI recordings.

Pipeline overview:
    protocol  -> parse the collector's raw .csi.bin / .jsonl recordings into frames
    csi       -> raw signed I/Q bytes to complex CSI, amplitude/phase, phase sanitization
    filters   -> median / Hampel / Butterworth denoising (operate per subcarrier over time)
    features  -> sliding-window statistics, PCA, STFT, change-point detection
    splits    -> leave-one-{person,position,day}-out grouping (no window leakage)
    models    -> classical baselines (logistic regression, RF, gradient boosting, SVM)

Everything here is classical signal processing + ML by design. There is no deep learning: the
goal is an honest, interpretable baseline whose generalization can be trusted, evaluated with
group-aware cross-validation so adjacent windows of one recording never straddle train and test.
"""

__version__ = "0.1.0"
