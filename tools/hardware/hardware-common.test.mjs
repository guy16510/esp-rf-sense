import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRoomConfig,
  evaluatePlacement,
  postJson,
  streamReport,
  toDashboardRoomGeometry,
} from './hardware-common.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

describe('hardware room guardrails', () => {
  it('blocks clustered receivers for position calibration', () => {
    const room = createRoomConfig({
      widthMeters: 4,
      heightMeters: 4,
      receivers: {
        A: { deviceId: '00000001', xMeters: 0.1, yMeters: 0.1 },
        B: { deviceId: '00000002', xMeters: 0.4, yMeters: 0.1 },
        C: { deviceId: '00000003', xMeters: 0.1, yMeters: 0.4 },
        D: { deviceId: '00000004', xMeters: 0.4, yMeters: 0.4 },
      },
    });

    expect(evaluatePlacement(room)).toMatchObject({ pass: false });
  });

  it('converts hardware room config to dashboard geometry', () => {
    const room = createRoomConfig({
      widthMeters: 4,
      heightMeters: 4,
      receivers: {
        A: { deviceId: '00000001', xMeters: 0, yMeters: 0 },
        B: { deviceId: '00000002', xMeters: 4, yMeters: 0 },
        C: { deviceId: '00000003', xMeters: 0, yMeters: 4 },
        D: { deviceId: '00000004', xMeters: 4, yMeters: 4 },
      },
    });

    const geometry = toDashboardRoomGeometry(room);
    expect(geometry.format).toBe('rfsense-room-geometry/1');
    expect(geometry.zones.center).toEqual({ x: 2, y: 2 });
    expect(evaluatePlacement(room)).toMatchObject({ pass: true });
  });
});

describe('hardware stream report', () => {
  it('passes four fresh stable streams', () => {
    const samples = Array.from({ length: 4 }, (_unused, index) => ({
      timestamp: index,
      readiness: { readyForCapture: true },
      fused: { invalidDatagrams: 0 },
      nodes: ['a', 'b', 'c', 'd'].map((deviceId) => ({
        deviceId,
        frameRateHz: 25,
        lossPpm: 0,
        ageSec: 0.1,
        csiLength: 512,
        frames: 100 + index,
        ready: true,
        readinessReasons: [],
      })),
    }));

    expect(streamReport(samples)).toMatchObject({ pass: true, failures: [] });
  });

  it('fails duplicate IDs and stale streams', () => {
    const report = streamReport([
      {
        timestamp: 0,
        readiness: { readyForCapture: false },
        fused: { invalidDatagrams: 0 },
        nodes: [
          { deviceId: 'same', frameRateHz: 25, lossPpm: 0, ageSec: 2, csiLength: 512, frames: 1, ready: false, readinessReasons: ['stale'] },
          { deviceId: 'same', frameRateHz: 25, lossPpm: 0, ageSec: 2, csiLength: 512, frames: 1, ready: false, readinessReasons: ['stale'] },
        ],
      },
    ]);

    expect(report.pass).toBe(false);
    expect(report.failures.join(' ')).toMatch(/expected 4|duplicate|age/u);
  });
});

describe('identify HTTP helper', () => {
  it('posts identify requests to mocked receivers', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/api/v1/identify' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ supported: true, ledType: 'ws2812', gpio: 48 }));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    await expect(postJson(`http://127.0.0.1:${port}`, '/api/v1/identify', { durationMs: 1000 })).resolves.toMatchObject({
      supported: true,
      ledType: 'ws2812',
    });
  });
});
