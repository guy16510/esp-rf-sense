import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardRecorder } from './dashboard-recorder.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('adaptive dashboard recording', () => {
  it('stops once four receivers provide enough diverse frames', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T20:00:00Z'));
    const dir = await mkdtemp(join(tmpdir(), 'rfsense-adaptive-'));
    dirs.push(dir);
    const recorder = new DashboardRecorder(dir);
    await recorder.start('adaptive-test', 90, 2000);

    for (let index = 0; index < 240; index += 1) {
      const deviceId = (index % 4) + 1;
      const csi = Buffer.alloc(64, index % 251);
      recorder.write(
        Buffer.from([index % 255]),
        {
          header: { deviceId, bootId: 1, packetSeq: index, flags: 0 },
          frames: [
            {
              frameSeq: index,
              timestampUs: BigInt(index),
              pingSeq: 0,
              rssi: -40 - (index % 20),
              noiseFloor: -95,
              channel: 6,
              secondaryChannel: 0,
              bandwidth: 20,
              phyMode: 0,
              rate: 0,
              firstWordInvalid: false,
              linkId: 0,
              csi,
            },
          ],
        } as never,
        Date.now(),
      );
    }

    vi.setSystemTime(new Date('2026-06-20T20:00:10Z'));
    const status = recorder.status();
    expect(status.receiverCount).toBe(4);
    expect(status.uniqueBuckets).toBeGreaterThanOrEqual(12);
    expect(status.adaptiveStopReady).toBe(true);
    expect(recorder.shouldAutoStop()).toBe(true);
    await recorder.stop();
  });

  it('does not stop when only three receivers contributed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T20:00:00Z'));
    const dir = await mkdtemp(join(tmpdir(), 'rfsense-adaptive-'));
    dirs.push(dir);
    const recorder = new DashboardRecorder(dir);
    await recorder.start('adaptive-test', 90, 2000);

    for (let index = 0; index < 300; index += 1) {
      const deviceId = (index % 3) + 1;
      recorder.write(
        Buffer.from([index % 255]),
        {
          header: { deviceId, bootId: 1, packetSeq: index, flags: 0 },
          frames: [{ frameSeq: index, timestampUs: BigInt(index), rssi: -50, firstWordInvalid: false, csi: Buffer.alloc(64, index % 251) }],
        } as never,
        Date.now(),
      );
    }

    vi.setSystemTime(new Date('2026-06-20T20:00:15Z'));
    expect(recorder.status().adaptiveStopReady).toBe(false);
    await recorder.stop();
  });
});
