import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DashboardState } from './contracts.js';
import { DashboardRecorder } from './dashboard-recorder.js';
import { fusePositionEstimates } from './multi-node-engine.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('position workflow', () => {
  it('fuses an accepted zone only when at least two receivers agree', () => {
    const result = fusePositionEstimates([
      node('left-wall', 0.9, 0.2, 0.5),
      node('left-wall', 0.8, 0.2, 0.5),
      node('door', 0.4, 0.5, 0.1),
    ]);

    expect(result).toMatchObject({
      accepted: true,
      zone: 'left-wall',
      contributors: 2,
    });
    expect(result?.agreement).toBeGreaterThan(0.75);
    expect(result?.x).toBeCloseTo(0.2);
    expect(result?.y).toBeCloseTo(0.5);
  });

  it('rejects a single-receiver position instead of drawing a false coordinate', () => {
    const result = fusePositionEstimates([
      node('door', 0.92, 0.5, 0.1),
      node(null, 0.2, null, null, false),
      node(null, 0.2, null, null, false),
    ]);

    expect(result).toMatchObject({
      accepted: false,
      zone: null,
      x: null,
      y: null,
      contributors: 1,
      reason: 'position needs 2 agreeing receivers',
    });
  });

  it('writes position metadata in flat and nested subject formats', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rf-position-'));
    temporaryDirectories.push(directory);
    const recorder = new DashboardRecorder(directory);
    const encoded = Buffer.from(
      JSON.stringify({
        label: 'occupied-door',
        target: 'position',
        subjectId: 'person-1',
        day: '2026-06-18',
        movement: 'stationary',
        position: { label: 'door', x: 0.5, y: 0.1 },
      }),
    ).toString('base64url');

    const started = await recorder.start(`rfsense-meta:${encoded}`, 5, 1);
    const stopped = await recorder.stop(true);
    expect(stopped.metaPath).toBe(started.metaPath);

    const metadata = JSON.parse(await readFile(stopped.metaPath!, 'utf8')) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      label: 'occupied-door',
      target: 'position',
      subjectId: 'person-1',
      day: '2026-06-18',
      movement: 'stationary',
      position: { label: 'door', x: 0.5, y: 0.1 },
      subject: {
        id: 'person-1',
        position: { label: 'door', x: 0.5, y: 0.1 },
      },
      complete: true,
    });
  });
});

function node(
  zone: string | null,
  confidence: number,
  x: number | null,
  y: number | null,
  accepted = true,
): DashboardState {
  return {
    timestamp: 0,
    state: accepted ? 'active' : 'clear',
    confidence,
    motion: 0.2,
    zone: accepted ? zone : null,
    position: {
      accepted,
      zone: accepted ? zone : null,
      x: accepted ? x : null,
      y: accepted ? y : null,
      confidence,
      margin: 0.5,
      contributors: 1,
      agreement: accepted ? 1 : 0,
      reason: accepted ? null : 'room classified as clear',
    },
    bubbles: [],
    amplitudeProfile: [],
    frameRateHz: 20,
    lossPpm: 0,
    ageSec: 0,
    deviceId: Math.random().toString(16).slice(2, 10),
    bootId: '00000001',
    frames: 64,
    datagrams: 64,
    invalidDatagrams: 0,
    mode: 'portable-model',
    modelTarget: 'position',
    scores: zone ? { [zone]: confidence } : { empty: 1 - confidence },
    diagnostics: {
      baselineReady: true,
      baselineSamples: 20,
      baselineRequired: 20,
      baselineProgress: 1,
      baselineMean: 0,
      baselineDeviation: 0,
      activationScore: accepted ? confidence : 0,
      activeStreak: 0,
      clearStreak: 0,
    },
    source: 'real',
    ready: true,
    readinessReasons: [],
  };
}
