import { describe, expect, it } from 'vitest';

import { decodeAmplitude, motionLevel, windowFeatures } from './features.js';
import type { CsiFrame } from './protocol.js';

function frame(bytes: number[]): CsiFrame {
  return {
    frameSeq: 1,
    timestampUs: 1,
    rssi: -40,
    firstWordInvalid: 0,
    csi: Buffer.from(bytes),
  };
}

describe('Node CSI feature extraction', () => {
  it('decodes ESP32 imaginary-real byte pairs', () => {
    expect([...decodeAmplitude(frame([3, 4, 5, 12]))]).toEqual([5, 13]);
  });

  it('computes motion across adjacent frames', () => {
    const value = motionLevel([Float64Array.from([1, 2]), Float64Array.from([3, 6])]);
    expect(value).toBe(3);
  });

  it('matches the Python feature vector shape', () => {
    const features = windowFeatures([
      Float64Array.from([1, 2, 3]),
      Float64Array.from([2, 4, 6]),
      Float64Array.from([3, 6, 9]),
    ]);
    expect(features).toHaveLength(12);
    expect(features.every(Number.isFinite)).toBe(true);
  });
});
