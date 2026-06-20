import { describe, expect, it } from 'vitest';
import { trainContinuousXYModel, type ContinuousXYExample } from './continuous-xy-model.js';
import { buildJointXYFeatures } from './joint-xy-features.js';
import type { AlignedPacket, ReceiverObservation } from './joint-packet-aligner.js';
import { LiveXYRuntime } from './live-xy-runtime.js';
import { encodeCsiFrameV2 } from './protocol-v2.js';

const rssis = [-45, -52, -49, -58];
const amplitudes = [40, 25, 30, 18];
const features = buildJointXYFeatures([alignedPacket()]);
const examples: ContinuousXYExample[] = Array.from({ length: 8 }, (_item, index) => ({
  xMeters: 2.5,
  yMeters: 1.5,
  features,
  recordingId: `r-${index}`,
  subjectId: 'p',
  day: '2026-06-20',
  orientationDegrees: 0,
  movement: 'stationary',
  receiverCount: 4,
  packetOverlap: 1,
  empty: false,
}));
const model = trainContinuousXYModel({
  examples,
  roomWidthMeters: 4,
  roomHeightMeters: 4,
  featureVersion: 1,
});

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

function alignedPacket(): AlignedPacket {
  const observations = Object.fromEntries(
    ['A', 'B', 'C', 'D'].map((slot, index) => [
      slot,
      observation(slot as 'A' | 'B' | 'C' | 'D', rssis[index]!, amplitudes[index]!),
    ]),
  ) as AlignedPacket['observations'];
  return {
    transmitterId: '77',
    transmitterBootId: '88',
    transmitterPacketSeq: 42,
    observations,
    receiverCount: 4,
    complete: true,
    firstReceivedAtMs: 1000,
    finalizedAtMs: 1003,
  };
}

function observation(slot: 'A' | 'B' | 'C' | 'D', rssi: number, amplitude: number): ReceiverObservation {
  return {
    receiverSlot: slot,
    receiverDeviceId: `rx-${slot}`,
    receiverBootId: `rx-${slot}:boot`,
    receiverFrameSeq: 42,
    receiverTimestampUs: 42000,
    transmitterId: '77',
    transmitterBootId: '88',
    transmitterPacketSeq: 42,
    rssi,
    noiseFloor: -95,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csi: Buffer.alloc(16, amplitude),
    receivedAtMs: 1000,
  };
}
