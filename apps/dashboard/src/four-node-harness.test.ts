import { afterEach, describe, expect, it } from 'vitest';

import { MultiNodeEngine } from './multi-node-engine.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import type { CsiDatagram } from './protocol.js';

const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe('four-node engine-to-web harness', () => {
  it('keeps four typed streams isolated and reports readiness changes', async () => {
    const engine = new MultiNodeEngine({
      requiredNodeCount: 4,
      motionThreshold: 0.01,
      minFrameRateHz: 5,
      staleAfterMs: 3000,
      maxLossPpm: 100_000,
    });
    for (let sequence = 0; sequence < 4; sequence++) {
      for (const streamId of [101, 102, 103, 104]) {
        engine.accept(
          datagram(
            streamId,
            1000 + streamId,
            sequence,
            sequence,
            sequence * 50_000,
            sequence % 2 === 0 ? 4 : 20,
          ),
          Date.now() + sequence * 50,
        );
      }
    }

    const dashboard = new MultiNodeDashboardServer(engine, {
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20,
    });
    servers.push(dashboard);
    await dashboard.start();
    await delay(60);

    const port = dashboard.address()?.port;
    expect(port).toBeTypeOf('number');
    let state = await fetch(`http://127.0.0.1:${port}/api/nodes`).then((response) =>
      response.json(),
    );
    expect(state.nodes).toHaveLength(4);
    expect(state.readiness.onlineNodeCount).toBe(4);
    expect(state.readiness.readyForCapture).toBe(true);
    expect(state.fused.amplitudeProfile).toEqual([12, 13, 14, 15]);
    expect(new Set(state.nodes.map((node: { deviceId: string }) => node.deviceId)).size).toBe(4);

    engine.recordInvalid();
    state = engine.snapshot();
    expect(state.readiness.readyForCapture).toBe(true);
    expect(state.readiness.reasons.join(' ')).toMatch(/malformed/u);

    for (let sequence = 0; sequence < 2; sequence++) {
      engine.accept(
        datagram(101, 9001, sequence, sequence + 10, 500_000 + sequence * 50_000, 12),
        Date.now(),
      );
    }
    state = engine.snapshot();
    const restarted = state.nodes.find((node) => node.deviceId === '00000065');
    expect(restarted?.missingPackets).toBe(0);

    const stale = engine.snapshot(Date.now() + 4000);
    expect(stale.readiness.onlineNodeCount).toBe(0);
    expect(stale.readiness.readyForCapture).toBe(false);
    expect(stale.fused.amplitudeProfile).toEqual([12, 13, 14, 15]);
  });

  it('uses collector receive cadence for node readiness', () => {
    const engine = new MultiNodeEngine({
      requiredNodeCount: 1,
      minFrameRateHz: 5,
      staleAfterMs: 3000,
      motionThreshold: 0.01,
    });
    const now = Date.now();
    for (let sequence = 0; sequence < 64; sequence++) {
      engine.accept(
        datagram(101, 1001, sequence, sequence, sequence * 500_000, sequence % 2 === 0 ? 4 : 20),
        now + sequence * 50,
      );
    }

    const [node] = engine.snapshot(now + 64 * 50).nodes;
    expect(node?.frameRateHz).toBeGreaterThan(5);
    expect(node?.ready).toBe(true);
  });

  it('marks under-rate nodes as not ready when a minimum frame rate is configured', () => {
    const engine = new MultiNodeEngine({
      requiredNodeCount: 1,
      minFrameRateHz: 5,
      staleAfterMs: 3000,
      motionThreshold: 0.01,
    });
    const now = Date.now();
    engine.accept(datagram(101, 1001, 0, 0, 0, 12), now);
    engine.accept(datagram(101, 1001, 1, 1, 1_000_000, 20), now + 1000);

    const [node] = engine.snapshot(now + 1100).nodes;
    expect(node?.frameRateHz).toBeLessThan(5);
    expect(node?.ready).toBe(false);
    expect(node?.readinessReasons?.join(' ')).toMatch(/frame rate/u);
  });

  it('rejects incompatible CSI widths without clearing the valid window', () => {
    const engine = new MultiNodeEngine({
      requiredNodeCount: 1,
      staleAfterMs: 3000,
      motionThreshold: 0.01,
    });
    const now = Date.now();
    for (let sequence = 0; sequence < 64; sequence++) {
      engine.accept(datagram(101, 1001, sequence, sequence, sequence * 50_000, 12, 8), now - 5000);
    }
    engine.accept(datagram(101, 1001, 64, 64, 3_200_000, 20, 12), now);
    engine.accept(datagram(101, 1001, 65, 65, 3_250_000, 24, 12), now + 50);

    const [node] = engine.snapshot(now + 100).nodes;
    expect(node?.subcarrierCount).toBe(4);
    expect(node?.frames).toBe(64);
    expect(node?.acceptedFrames).toBe(64);
    expect(node?.rejectedIncompatibleFrames).toBe(2);
    expect(node?.bufferResetCount).toBe(0);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function datagram(
  deviceId: number,
  bootId: number,
  packetSequence: number,
  frameSequence: number,
  timestampUs: number,
  amplitude: number,
  csiByteLength = 8,
): CsiDatagram {
  const csi = Buffer.alloc(csiByteLength);
  for (let index = 0; index < csi.length; index += 2) {
    csi[index] = amplitude + index / 2;
    csi[index + 1] = 0;
  }
  return {
    header: {
      protocolVersion: 1,
      flags: 0,
      captureMode: 0,
      deviceId,
      bootId,
      packetSeq: packetSequence,
      batchSeq: packetSequence,
      frameCount: 1,
      payloadLen: 28 + csi.length,
    },
    frames: [
      {
        frameSeq: frameSequence,
        timestampUs,
        pingSeq: frameSequence,
        rssi: -45,
        noiseFloor: -95,
        channel: 6,
        secondaryChannel: 0,
        bandwidth: 0,
        phyMode: 2,
        rate: 11,
        firstWordInvalid: 0,
        linkId: 1,
        csiLen: csi.length,
        csi,
      },
    ],
  };
}
