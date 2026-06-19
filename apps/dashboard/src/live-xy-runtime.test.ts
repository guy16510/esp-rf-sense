import { describe, expect, it } from 'vitest';
import { LiveXYRuntime } from './live-xy-runtime.js';
import { encodeCsiFrameV2 } from './protocol-v2.js';
import type { XYModel, XYTrainingExample } from './simulated-xy-pipeline.js';

const rssis = [-45, -52, -49, -58];
const amplitudes = [40, 25, 30, 18];
const base = amplitudes.flatMap((value, index) => [rssis[index]!, value, value, 16, 1]);
const features = [...base, 7, 4, 13, -3, 6, 9];
const example: XYTrainingExample = {
  xMeters: 2.5, yMeters: 1.5, features,
  recordingId: 'r', subjectId: 'p', day: 'd', orientationDegrees: 0,
  receiverCount: 4, packetOverlap: 1, empty: false,
};
const model: XYModel = {
  examples: Array.from({ length: 8 }, () => example),
  featureMean: Array(26).fill(0), featureScale: Array(26).fill(1),
  densityThreshold: 1, uncertaintyThreshold: 0.75,
};

describe('LiveXYRuntime', () => {
  it('aligns four protocol v2 receivers and predicts XY', () => {
    const mappings = ['A', 'B', 'C', 'D'].map((slot, index) => ({ slot: slot as 'A' | 'B' | 'C' | 'D', port: 6101 + index, deviceId: `rx-${slot}` }));
    const runtime = new LiveXYRuntime(model, mappings);
    const predictions = mappings.flatMap((mapping, index) => runtime.acceptDatagram(encodeCsiFrameV2({
      receiverFrameSeq: 42, receiverTimestampUs: 42000n,
      transmitterId: 77, transmitterBootId: 88, transmitterPacketSeq: 42,
      rssi: rssis[index]!, noiseFloor: -95, channel: 6, bandwidthMhz: 20,
      firstWordInvalid: false, csi: Buffer.alloc(16, amplitudes[index]!),
    }), { address: '127.0.0.1', port: mapping.port }, 1000 + index));
    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toMatchObject({ accepted: true, xMeters: 2.5, yMeters: 1.5 });
    expect(runtime.snapshot().alignment.fourOfFourCount).toBe(1);
  });
});
