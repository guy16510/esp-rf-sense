import { afterEach, describe, expect, it } from "vitest";

import { MultiNodeEngine } from "./multi-node-engine.js";
import { MultiNodeDashboardServer } from "./multi-node-web-server.js";
import type { CsiDatagram } from "./protocol.js";

const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe("four-node engine-to-web harness", () => {
  it("keeps four typed streams isolated and reports readiness changes", async () => {
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
          Date.now(),
        );
      }
    }

    const dashboard = new MultiNodeDashboardServer(engine, {
      host: "127.0.0.1",
      port: 0,
      intervalMs: 20,
    });
    servers.push(dashboard);
    await dashboard.start();
    await delay(60);

    const port = dashboard.address()?.port;
    expect(port).toBeTypeOf("number");
    let state = await fetch(`http://127.0.0.1:${port}/api/nodes`).then(
      (response) => response.json(),
    );
    expect(state.nodes).toHaveLength(4);
    expect(state.readiness.onlineNodeCount).toBe(4);
    expect(state.readiness.readyForCapture).toBe(true);
    expect(
      new Set(state.nodes.map((node: { deviceId: string }) => node.deviceId))
        .size,
    ).toBe(4);

    engine.recordInvalid();
    state = engine.snapshot();
    expect(state.readiness.readyForCapture).toBe(true);
    expect(state.readiness.reasons.join(" ")).toMatch(/malformed/u);

    for (let sequence = 0; sequence < 2; sequence++) {
      engine.accept(
        datagram(
          101,
          9001,
          sequence,
          sequence + 10,
          500_000 + sequence * 50_000,
          12,
        ),
        Date.now(),
      );
    }
    state = engine.snapshot();
    const restarted = state.nodes.find(
      (node) => node.deviceId === "00000065",
    );
    expect(restarted?.missingPackets).toBe(0);

    const stale = engine.snapshot(Date.now() + 4000);
    expect(stale.readiness.onlineNodeCount).toBe(0);
    expect(stale.readiness.readyForCapture).toBe(false);
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
): CsiDatagram {
  return {
    header: {
      flags: 0,
      deviceId,
      bootId,
      packetSeq: packetSequence,
      frameCount: 1,
    },
    frames: [
      {
        frameSeq: frameSequence,
        timestampUs,
        rssi: -45,
        firstWordInvalid: 0,
        csi: Buffer.from([
          amplitude,
          0,
          amplitude + 1,
          0,
          amplitude + 2,
          0,
          amplitude + 3,
          0,
        ]),
      },
    ],
  };
}
