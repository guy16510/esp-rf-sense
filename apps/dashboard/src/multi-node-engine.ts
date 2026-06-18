import type { DashboardState } from "./contracts.js";
import { RealtimeEngine, type EngineOptions } from "./engine.js";
import type { CsiDatagram } from "./protocol.js";

export interface MultiNodeOptions extends EngineOptions {
  requiredNodeCount?: number;
  staleAfterMs?: number;
  minFrameRateHz?: number;
  maxLossPpm?: number;
}

export interface MultiNodeSnapshot {
  timestamp: number;
  readiness: {
    readyForCapture: boolean;
    requiredNodeCount: number;
    onlineNodeCount: number;
    reasons: string[];
  };
  nodes: DashboardState[];
  fused: DashboardState & {
    contributingNodes: string[];
    disagreement: number;
  };
}

interface NodeRuntime {
  engine: RealtimeEngine;
  deviceId: number;
  bootId: number;
  lastPacketSeq: number | null;
  missingPackets: number;
  duplicatePackets: number;
  outOfOrderPackets: number;
  csiLength: number;
}

export class MultiNodeEngine {
  private readonly runtimes = new Map<number, NodeRuntime>();
  private invalidDatagrams = 0;

  constructor(private readonly options: MultiNodeOptions = {}) {}

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    const id = datagram.header.deviceId >>> 0;
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {
        engine: new RealtimeEngine({
          ...(this.options.windowFrames === undefined
            ? {}
            : { windowFrames: this.options.windowFrames }),
          ...(this.options.motionThreshold === undefined
            ? {}
            : { motionThreshold: this.options.motionThreshold }),
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
        }),
        deviceId: id,
        bootId: datagram.header.bootId >>> 0,
        lastPacketSeq: null,
        missingPackets: 0,
        duplicatePackets: 0,
        outOfOrderPackets: 0,
        csiLength: 0,
      };
      this.runtimes.set(id, runtime);
    }

    if (runtime.bootId !== (datagram.header.bootId >>> 0)) {
      runtime.bootId = datagram.header.bootId >>> 0;
      runtime.lastPacketSeq = null;
      runtime.missingPackets = 0;
      runtime.duplicatePackets = 0;
      runtime.outOfOrderPackets = 0;
      runtime.engine.resetBaseline();
    }

    this.trackSequence(runtime, datagram.header.packetSeq >>> 0);
    runtime.csiLength = datagram.frames.at(-1)?.csi.length ?? runtime.csiLength;
    runtime.engine.accept(datagram, receivedAtMs);
  }

  recordInvalid(): void {
    this.invalidDatagrams++;
  }

  resetBaseline(deviceId?: string): void {
    if (deviceId) {
      const runtime = this.runtimes.get(Number.parseInt(deviceId, 16) >>> 0);
      if (!runtime) throw new Error(`unknown node ${deviceId}`);
      runtime.engine.resetBaseline();
      return;
    }
    for (const runtime of this.runtimes.values()) runtime.engine.resetBaseline();
  }

  snapshot(nowMs = Date.now()): MultiNodeSnapshot {
    const nodes = [...this.runtimes.values()]
      .map((runtime) => this.nodeSnapshot(runtime, nowMs))
      .sort((left, right) =>
        String(left.deviceId).localeCompare(String(right.deviceId)),
      );
    const required = Math.max(1, this.options.requiredNodeCount ?? 4);
    const readyNodes = nodes.filter((node) => node.ready);
    const reasons: string[] = [];
    if (nodes.length < required)
      reasons.push(`discovered ${nodes.length} of ${required} required nodes`);
    if (readyNodes.length < required)
      reasons.push(`${readyNodes.length} of ${required} required nodes are ready`);
    if (this.invalidDatagrams > 0)
      reasons.push(`${this.invalidDatagrams} malformed datagrams observed`);

    return {
      timestamp: nowMs / 1000,
      readiness: {
        readyForCapture: readyNodes.length >= required,
        requiredNodeCount: required,
        onlineNodeCount: readyNodes.length,
        reasons,
      },
      nodes,
      fused: fuse(readyNodes, nodes, nowMs, reasons),
    };
  }

  dashboardSnapshot(nowMs = Date.now()): DashboardState {
    return this.snapshot(nowMs).fused;
  }

  private nodeSnapshot(runtime: NodeRuntime, nowMs: number): DashboardState {
    const base = runtime.engine.snapshot(nowMs);
    const totalPackets = base.datagrams + runtime.missingPackets;
    const lossPpm =
      totalPackets > 0
        ? Math.round((runtime.missingPackets / totalPackets) * 1_000_000)
        : 0;
    const reasons: string[] = [];
    if (base.ageSec === null) reasons.push("no CSI frames received");
    if (
      base.ageSec !== null &&
      base.ageSec > (this.options.staleAfterMs ?? 3000) / 1000
    )
      reasons.push(`last frame ${base.ageSec.toFixed(1)}s ago`);
    if (!base.diagnostics.baselineReady)
      reasons.push("empty-room baseline is not ready");
    if (base.frameRateHz < (this.options.minFrameRateHz ?? 5))
      reasons.push(`frame rate ${base.frameRateHz.toFixed(1)} Hz is below minimum`);
    if (lossPpm > (this.options.maxLossPpm ?? 100_000))
      reasons.push(`packet loss ${lossPpm} ppm exceeds maximum`);
    if (runtime.csiLength <= 0) reasons.push("CSI payload is empty");

    return {
      ...base,
      deviceId: hex(runtime.deviceId),
      bootId: hex(runtime.bootId),
      lossPpm,
      csiLength: runtime.csiLength,
      subcarrierCount: Math.floor(runtime.csiLength / 2),
      missingPackets: runtime.missingPackets,
      duplicatePackets: runtime.duplicatePackets,
      outOfOrderPackets: runtime.outOfOrderPackets,
      ready: reasons.length === 0,
      readinessReasons: reasons,
      source: "real",
    };
  }

  private trackSequence(runtime: NodeRuntime, packetSeq: number): void {
    if (runtime.lastPacketSeq === null) {
      runtime.lastPacketSeq = packetSeq;
      return;
    }
    const delta = (packetSeq - runtime.lastPacketSeq) >>> 0;
    if (delta === 0) {
      runtime.duplicatePackets++;
      return;
    }
    if (delta > 0x7fffffff) {
      runtime.outOfOrderPackets++;
      return;
    }
    runtime.missingPackets += Math.max(0, delta - 1);
    runtime.lastPacketSeq = packetSeq;
  }
}

function fuse(
  readyNodes: DashboardState[],
  allNodes: DashboardState[],
  nowMs: number,
  readinessReasons: string[],
): MultiNodeSnapshot["fused"] {
  const weighted = readyNodes.reduce(
    (accumulator, node) => {
      const quality = Math.max(0.05, 1 - Math.min(1, node.lossPpm / 1_000_000));
      const activeScore =
        node.state === "active" ? node.confidence : 1 - node.confidence;
      accumulator.weight += quality;
      accumulator.active += activeScore * quality;
      accumulator.motion += node.motion * quality;
      accumulator.rate += node.frameRateHz * quality;
      return accumulator;
    },
    { weight: 0, active: 0, motion: 0, rate: 0 },
  );
  const activeProbability =
    weighted.weight > 0 ? weighted.active / weighted.weight : 0;
  const motion = weighted.weight > 0 ? weighted.motion / weighted.weight : 0;
  const state =
    readyNodes.length === 0
      ? allNodes.some((node) => node.state === "baseline")
        ? "baseline"
        : "waiting"
      : activeProbability >= 0.5
        ? "active"
        : "clear";
  const activeVotes = readyNodes.filter((node) => node.state === "active").length;
  const clearVotes = readyNodes.filter((node) => node.state === "clear").length;
  const disagreement =
    readyNodes.length > 0 ? Math.min(activeVotes, clearVotes) / readyNodes.length : 0;
  const baselineSamples = allNodes.reduce(
    (sum, node) => sum + node.diagnostics.baselineSamples,
    0,
  );
  const baselineRequired = allNodes.reduce(
    (sum, node) => sum + node.diagnostics.baselineRequired,
    0,
  );
  const confidence =
    state === "active"
      ? activeProbability
      : state === "clear"
        ? 1 - activeProbability
        : 0;

  return {
    timestamp: nowMs / 1000,
    state,
    confidence,
    motion,
    zone: null,
    bubbles: [],
    amplitudeProfile: [],
    frameRateHz: weighted.weight > 0 ? weighted.rate / weighted.weight : 0,
    lossPpm:
      readyNodes.length > 0
        ? Math.max(...readyNodes.map((node) => node.lossPpm))
        : 0,
    ageSec:
      readyNodes.length > 0
        ? Math.max(...readyNodes.map((node) => node.ageSec ?? 0))
        : null,
    deviceId: null,
    bootId: null,
    frames: readyNodes.reduce((sum, node) => sum + node.frames, 0),
    datagrams: allNodes.reduce((sum, node) => sum + node.datagrams, 0),
    invalidDatagrams: allNodes.reduce(
      (sum, node) => sum + node.invalidDatagrams,
      0,
    ),
    mode: "fused",
    scores: { active: activeProbability, clear: 1 - activeProbability },
    diagnostics: {
      baselineReady:
        allNodes.length > 0 &&
        allNodes.every((node) => node.diagnostics.baselineReady),
      baselineSamples,
      baselineRequired,
      baselineProgress:
        baselineRequired > 0 ? Math.min(1, baselineSamples / baselineRequired) : 0,
      baselineMean: null,
      baselineDeviation: 0,
      activationScore: activeProbability,
      activeStreak: 0,
      clearStreak: 0,
    },
    source: "real",
    ready: readinessReasons.length === 0,
    readinessReasons,
    contributingNodes: readyNodes.map((node) => node.deviceId ?? "unknown"),
    disagreement,
  };
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
