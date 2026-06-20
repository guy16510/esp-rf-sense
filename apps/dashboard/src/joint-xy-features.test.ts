import { describe, expect, it } from 'vitest';
import { buildJointXYFeatures, jointXYFeatureQuality } from './joint-xy-features.js';
import type { AlignedPacket, ReceiverObservation, ReceiverSlot } from './joint-packet-aligner.js';

describe('buildJointXYFeatures', () => {
  it('returns identical vectors for training and live extraction of the same aligned sample', () => {
    const sample = [packet(100, ['A', 'B', 'C', 'D']), packet(101, ['A', 'B', 'C', 'D'])];
    const trainingFeatures = buildJointXYFeatures(sample);
    const liveFeatures = buildJointXYFeatures(structuredClone(sample));
    expect(liveFeatures).toEqual(trainingFeatures);
    expect(trainingFeatures.length).toBeGreaterThan(80);
  });

  it('reports three receiver degraded quality without inventing a fourth stream', () => {
    const sample = [packet(100, ['A', 'B', 'C']), packet(101, ['A', 'B', 'C'])];
    const quality = jointXYFeatureQuality(sample);
    expect(quality).toMatchObject({
      receiverCount: 3,
      packetOverlap: 0.75,
      completePacketRatio: 0,
      windowPackets: 2,
    });
  });
});

function packet(sequence: number, slots: ReceiverSlot[]): AlignedPacket {
  const observations = { A: null, B: null, C: null, D: null } as AlignedPacket['observations'];
  for (const slot of slots) observations[slot] = observation(slot, sequence);
  return {
    transmitterId: '77',
    transmitterBootId: '88',
    transmitterPacketSeq: sequence,
    observations,
    receiverCount: slots.length,
    complete: slots.length === 4,
    firstReceivedAtMs: 1000 + sequence,
    finalizedAtMs: 1004 + sequence,
  };
}

function observation(slot: ReceiverSlot, sequence: number): ReceiverObservation {
  const slotIndex = ['A', 'B', 'C', 'D'].indexOf(slot);
  return {
    receiverSlot: slot,
    receiverDeviceId: `rx-${slot}`,
    receiverBootId: `rx-${slot}:boot`,
    receiverFrameSeq: sequence + slotIndex,
    receiverTimestampUs: sequence * 1000 + slotIndex,
    transmitterId: '77',
    transmitterBootId: '88',
    transmitterPacketSeq: sequence,
    rssi: -45 - slotIndex * 3,
    noiseFloor: -95,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csi: Buffer.alloc(32, 20 + slotIndex * 5 + (sequence % 3)),
    receivedAtMs: 1000 + sequence + slotIndex,
  };
}
