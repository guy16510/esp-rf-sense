import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JointPositionEngine } from './joint-position-engine.js';
import type { ReceiverSourceMapping } from './live-xy-runtime.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import { encodeCsiFrameV2 } from './protocol-v2.js';

const mappings: ReceiverSourceMapping[] = ['A', 'B', 'C', 'D'].map((slot, index) => ({
  slot: slot as ReceiverSourceMapping['slot'],
  deviceId: `rx-${slot.toLowerCase()}`,
  port: 6201 + index,
}));
const points = [
  { xMeters: 0.8, yMeters: 0.7, amplitudes: [18, 42, 25, 31] },
  { xMeters: 2.1, yMeters: 1.8, amplitudes: [31, 20, 44, 26] },
  { xMeters: 3.2, yMeters: 2.9, amplitudes: [45, 26, 22, 48] },
];
const temporaryDirectories: string[] = [];
const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('continuous XY HTTP activation', () => {
  it('trains, activates, and publishes changing XY coordinates without restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rf-xy-http-'));
    temporaryDirectories.push(directory);
    await writeContinuousRecordings(directory);

    const modelPath = join(directory, 'continuous-xy.json');
    const server = new MultiNodeDashboardServer(new JointPositionEngine({ requiredNodeCount: 4 }), {
      host: '127.0.0.1',
      port: 0,
      intervalMs: 10,
      recordingsDir: directory,
      modelPath,
      receiverMappings: mappings,
    });
    servers.push(server);
    await server.start();
    const port = server.address()!.port;

    const response = await fetch(`http://127.0.0.1:${port}/api/model/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'continuous-xy',
        path: modelPath,
        roomWidthMeters: 4,
        roomHeightMeters: 4,
        sourceMappings: sourceMappings(),
        windowPackets: 4,
        stepPackets: 1,
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      loaded: true,
      target: 'continuous-xy',
      classes: ['continuous-xy'],
    });

    const seen: Array<{ xMeters: number; yMeters: number }> = [];
    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      let predictionCount = 0;
      for (let sequence = 0; sequence < 12; sequence += 1) {
        predictionCount += feedPoint(server, points[pointIndex]!, pointIndex * 12 + sequence);
      }
      expect(predictionCount).toBeGreaterThan(0);
      const previous = seen.at(-1);
      const position = await acceptedPosition(port, previous);
      seen.push(position);
    }

    expect(seen).toHaveLength(3);
    expect(seen[0]!.xMeters).toBeLessThan(seen[1]!.xMeters);
    expect(seen[1]!.xMeters).toBeLessThan(seen[2]!.xMeters);
    expect(seen[0]!.yMeters).toBeLessThan(seen[1]!.yMeters);
    expect(seen[1]!.yMeters).toBeLessThan(seen[2]!.yMeters);
  });
});

async function writeContinuousRecordings(directory: string): Promise<void> {
  for (const [pointIndex, point] of points.entries()) {
    const name = `point-${pointIndex}`;
    await writeFile(
      join(directory, `${name}.meta.json`),
      `${JSON.stringify(
        {
          name,
          complete: true,
          label: `occupied-${pointIndex}`,
          target: 'continuous-xy',
          recordingId: name,
          subjectId: 'person-1',
          day: '2026-06-20',
          movement: 'stationary',
          xMeters: point.xMeters,
          yMeters: point.yMeters,
        },
        null,
        2,
      )}\n`,
    );
    const lines: string[] = [];
    for (let sequence = 0; sequence < 12; sequence += 1) {
      for (let slotIndex = 0; slotIndex < mappings.length; slotIndex += 1) {
        const mapping = mappings[slotIndex]!;
        lines.push(JSON.stringify(jsonLine(point.amplitudes[slotIndex]!, sequence, mapping.port!)));
      }
    }
    await writeFile(join(directory, `${name}.jsonl`), `${lines.join('\n')}\n`);
  }
}

function feedPoint(
  server: MultiNodeDashboardServer,
  point: (typeof points)[number],
  sequence: number,
): number {
  let predictions = 0;
  for (let slotIndex = 0; slotIndex < mappings.length; slotIndex += 1) {
    const mapping = mappings[slotIndex]!;
    predictions += server.acceptProtocolV2Datagram(
      frame(point.amplitudes[slotIndex]!, sequence),
      { address: '127.0.0.1', port: mapping.port! },
      1000 + sequence,
    ).length;
  }
  return predictions;
}

async function acceptedPosition(
  port: number,
  previous?: { xMeters: number; yMeters: number },
): Promise<{ xMeters: number; yMeters: number }> {
  let lastPayload: unknown = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/nodes`);
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      fused?: {
        modelTarget?: string;
        position?: { accepted?: boolean; xMeters?: number | null; yMeters?: number | null };
      };
    };
    lastPayload = payload;
    const position = payload.fused?.position;
    if (
      payload.fused?.modelTarget === 'continuous-xy' &&
      position?.accepted &&
      Number.isFinite(position.xMeters) &&
      Number.isFinite(position.yMeters) &&
      (!previous ||
        Math.hypot(position.xMeters! - previous.xMeters, position.yMeters! - previous.yMeters) > 0.2)
    ) {
      return { xMeters: position.xMeters!, yMeters: position.yMeters! };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`continuous XY position was not accepted: ${JSON.stringify(lastPayload)}`);
}

function sourceMappings() {
  return Object.fromEntries(
    mappings.map((mapping) => [
      mapping.slot,
      { deviceId: mapping.deviceId, port: mapping.port },
    ]),
  );
}

function jsonLine(amplitude: number, sequence: number, port: number) {
  return {
    protocolVersion: 2,
    recvUnixMs: 1000 + sequence,
    source: { address: '127.0.0.1', port },
    receiverFrameSeq: sequence,
    receiverTimestampUs: String(sequence * 1000),
    transmitterId: 77,
    transmitterBootId: 88,
    transmitterPacketSeq: sequence,
    rssi: rssiFor(amplitude),
    noiseFloor: -95,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csiBase64: Buffer.alloc(16, amplitude).toString('base64'),
  };
}

function frame(amplitude: number, sequence: number): Buffer {
  return encodeCsiFrameV2({
    receiverFrameSeq: sequence,
    receiverTimestampUs: BigInt(sequence * 1000),
    transmitterId: 77,
    transmitterBootId: 88,
    transmitterPacketSeq: sequence,
    rssi: rssiFor(amplitude),
    noiseFloor: -95,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csi: Buffer.alloc(16, amplitude),
  });
}

function rssiFor(amplitude: number): number {
  return Math.round(-40 - amplitude / 10);
}
