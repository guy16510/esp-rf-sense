import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { buildContinuousXYDataset } from './continuous-xy-dataset.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('continuous XY dataset receiver mapping', () => {
  it('infers four receiver slots from distinct recorded UDP sources when only device IDs are configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfsense-xy-'));
    dirs.push(dir);
    const name = 'grid-center';
    await writeFile(
      join(dir, `${name}.meta.json`),
      JSON.stringify({
        name,
        complete: true,
        target: 'continuous-xy',
        label: 'occupied-center',
        recordingId: name,
        subjectId: 'person-1',
        day: '2026-06-20',
        movement: 'stationary',
        xMeters: 2,
        yMeters: 1.5,
      }),
    );

    const lines: string[] = [];
    for (let packet = 1; packet <= 4; packet += 1) {
      for (let receiver = 0; receiver < 4; receiver += 1) {
        lines.push(
          JSON.stringify({
            protocolVersion: 2,
            recvUnixMs: 1_000 + packet,
            source: { address: `192.168.1.${20 + receiver}`, port: 5000 + receiver },
            receiverFrameSeq: packet,
            receiverTimestampUs: packet * 1_000 + receiver,
            transmitterId: 1,
            transmitterBootId: 1,
            transmitterPacketSeq: packet,
            rssi: -45 - receiver,
            noiseFloor: -95,
            channel: 6,
            bandwidthMhz: 20,
            firstWordInvalid: false,
            csiBase64: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64'),
          }),
        );
      }
    }
    await writeFile(join(dir, `${name}.jsonl`), `${lines.join('\n')}\n`);

    const examples = await buildContinuousXYDataset({
      recordingsDir: dir,
      sourceMappings: {
        A: { deviceId: '00000001' },
        B: { deviceId: '00000002' },
        C: { deviceId: '00000003' },
        D: { deviceId: '00000004' },
      },
      windowPackets: 4,
      stepPackets: 1,
    });

    expect(examples).toHaveLength(1);
    expect(examples[0]?.receiverCount).toBe(4);
    expect(examples[0]?.packetOverlap).toBe(1);
    expect(examples[0]?.xMeters).toBe(2);
    expect(examples[0]?.yMeters).toBe(1.5);
  });
});
