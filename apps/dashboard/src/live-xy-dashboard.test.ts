import { describe, expect, it } from 'vitest';
import { trainContinuousXYModel, type ContinuousXYExample } from './continuous-xy-model.js';
import { buildJointXYFeatures } from './joint-xy-features.js';
import type { AlignedPacket, ReceiverObservation } from './joint-packet-aligner.js';
import { encodeCsiFrameV2 } from './protocol-v2.js';
import { createXYDashboardRuntime } from './xy-live-cli.js';

const rssis = [-45, -52, -49, -58];
const amplitudes = [40, 25, 30, 18];
const features = buildJointXYFeatures([alignedPacket()]);
const example: ContinuousXYExample = {
  xMeters: 2.5,
  yMeters: 1.5,
  features,
  recordingId: 'recording-1',
  subjectId: 'person-1',
  day: '2026-06-20',
  orientationDegrees: 0,
  movement: 'stationary',
  receiverCount: 4,
  packetOverlap: 1,
  empty: false,
};
const model = trainContinuousXYModel({
  examples: Array.from({ length: 8 }, (_item, index) => ({
    ...example,
    recordingId: `recording-${index}`,
  })),
  roomWidthMeters: 4,
  roomHeightMeters: 4,
  featureVersion: 1,
});
const mappings = ['A', 'B', 'C', 'D'].map((slot, index) => ({
  slot: slot as 'A' | 'B' | 'C' | 'D',
  port: 6101 + index,
  deviceId: `rx-${slot.toLowerCase()}`,
}));

describe('live XY dashboard integration', () => {
  it('publishes accepted XY coordinates through the real dashboard API', async () => {
    const { runtime, dashboard } = createXYDashboardRuntime(model, mappings, {
      port: 0,
      intervalMs: 20,
      roomWidthMeters: 4,
      roomHeightMeters: 4,
    });
    await dashboard.start();
    try {
      const predictions = mappings.flatMap((mapping, index) => runtime.acceptDatagram(
        encodeCsiFrameV2({
          receiverFrameSeq: 42,
          receiverTimestampUs: 42000n,
          transmitterId: 77,
          transmitterBootId: 88,
          transmitterPacketSeq: 42,
          rssi: rssis[index]!,
          noiseFloor: -95,
          channel: 6,
          bandwidthMhz: 20,
          firstWordInvalid: false,
          csi: Buffer.alloc(16, amplitudes[index]!),
        }),
        { address: '127.0.0.1', port: mapping.port },
        1000 + index,
      ));
      expect(predictions).toHaveLength(1);

      const address = dashboard.address();
      expect(address).not.toBeNull();
      let payload: {
        fused: {
          modelTarget?: string;
          position?: { accepted: boolean; x: number | null; y: number | null; contributors: number };
        };
      } | null = null;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${address!.port}/api/nodes`);
        expect(response.ok).toBe(true);
        payload = await response.json() as typeof payload;
        if (payload?.fused.position?.accepted) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(payload?.fused.modelTarget).toBe('continuous-xy');
      expect(payload?.fused.position).toMatchObject({
        accepted: true,
        x: 0.625,
        y: 0.375,
        xMeters: 2.5,
        yMeters: 1.5,
        contributors: 4,
      });
    } finally {
      await dashboard.stop();
    }
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
