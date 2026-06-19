import type { DashboardState, PositionEstimate } from './contracts.js';
import type { PortablePrototypeModel } from './model.js';
import { RealtimeEngine, type EngineOptions } from './engine.js';
import type { CsiDatagram } from './protocol.js';

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
  bootChangeCount: number;
}

export class MultiNodeEngine {
  private readonly runtimes = new Map<number, NodeRuntime>();
  private invalidDatagrams = 0;
  private model: PortablePrototypeModel | undefined;

  constructor(private readonly options: MultiNodeOptions = {}) {
    this.model = options.model;
  }

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
          ...(this.model === undefined ? {} : { model: this.model }),
        }),
        deviceId: id,
        bootId: datagram.header.bootId >>> 0,
        lastPacketSeq: null,
        missingPackets: 0,
        duplicatePackets: 0,
        outOfOrderPackets: 0,
        csiLength: 0,
        bootChangeCount: 0,
      };
      this.runtimes.set(id, runtime);
    }

    if (runtime.bootId !== datagram.header.bootId >>> 0) {
      runtime.bootId = datagram.header.bootId >>> 0;
      runtime.lastPacketSeq = null;
      runtime.missingPackets = 0;
      runtime.duplicatePackets = 0;
      runtime.outOfOrderPackets = 0;
      runtime.bootChangeCount++;
      runtime.engine.resetBaseline('esp32-reboot');
    }

    this.trackSequence(runtime, datagram.header.packetSeq >>> 0);
    runtime.engine.accept(datagram, receivedAtMs);
    const shape = runtime.engine.snapshot(receivedAtMs).diagnostics.currentCsiShape;
    runtime.csiLength = shape?.csiLength ?? runtime.csiLength;
  }

  recordInvalid(): void {
    this.invalidDatagrams++;
  }

  resetBaseline(deviceId?: string): void {
    if (deviceId) {
      const runtime = this.runtimes.get(Number.parseInt(deviceId, 16) >>> 0);
      if (!runtime) throw new Error(`unknown node ${deviceId}`);
      runtime.engine.resetBaseline('explicit-baseline-reset');
      return;
    }
    for (const runtime of this.runtimes.values())
      runtime.engine.resetBaseline('explicit-baseline-reset');
  }

  setModel(model?: PortablePrototypeModel): void {
    this.model = model;
    for (const runtime of this.runtimes.values()) runtime.engine.setModel(model);
  }

  snapshot(nowMs = Date.now()): MultiNodeSnapshot {
    const nodes = [...this.runtimes.values()]
      .map((runtime) => this.nodeSnapshot(runtime, nowMs))
      .sort((left, right) => String(left.deviceId).localeCompare(String(right.deviceId)));
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
    const currentShape = base.diagnostics.currentCsiShape;
    const totalPackets = base.datagrams + runtime.missingPackets;
    const lossPpm =
      totalPackets > 0 ? Math.round((runtime.missingPackets / totalPackets) * 1_000_000) : 0;
    const reasons: string[] = [];
    if (base.ageSec === null) reasons.push('no CSI frames received');
    if (base.ageSec !== null && base.ageSec > (this.options.staleAfterMs ?? 3000) / 1000)
      reasons.push(`last frame ${base.ageSec.toFixed(1)}s ago`);
    if (!base.diagnostics.baselineReady) reasons.push('empty-room baseline is not ready');
    if (this.options.minFrameRateHz !== undefined && base.frameRateHz < this.options.minFrameRateHz)
      reasons.push(
        `frame rate ${base.frameRateHz.toFixed(1)} Hz is below ${this.options.minFrameRateHz.toFixed(
          1,
        )} Hz`,
      );
    if (lossPpm > (this.options.maxLossPpm ?? 100_000))
      reasons.push(`packet loss ${lossPpm} ppm exceeds maximum`);
    if (runtime.csiLength <= 0) reasons.push('no canonical CSI stream selected');
    if (base.frames === 0 && (base.acceptedFrames ?? 0) > 0)
      reasons.push(`model-buffer reset: ${base.lastBufferResetReason ?? 'unknown reason'}`);
    if (base.frames === 0 && (base.parsedFrames ?? 0) > 0 && (base.acceptedFrames ?? 0) === 0)
      reasons.push('all parsed frames were rejected before the model buffer');

    return {
      ...base,
      deviceId: hex(runtime.deviceId),
      bootId: hex(runtime.bootId),
      lossPpm,
      csiLength: currentShape?.csiLength ?? runtime.csiLength,
      subcarrierCount: currentShape?.subcarrierCount ?? Math.floor(runtime.csiLength / 2),
      missingPackets: runtime.missingPackets,
      duplicatePackets: runtime.duplicatePackets,
      outOfOrderPackets: runtime.outOfOrderPackets,
      diagnostics: {
        ...base.diagnostics,
        bootChangeCount: runtime.bootChangeCount,
      },
      ready: reasons.length === 0,
      readinessReasons: reasons,
      source: 'real',
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
): MultiNodeSnapshot['fused'] {
  const weighted = readyNodes.reduce(
    (accumulator, node) => {
      const quality = Math.max(0.05, 1 - Math.min(1, node.lossPpm / 1_000_000));
      const activeScore = node.state === 'active' ? node.confidence : 1 - node.confidence;
      accumulator.weight += quality;
      accumulator.active += activeScore * quality;
      accumulator.motion += node.motion * quality;
      accumulator.rate += node.frameRateHz * quality;
      return accumulator;
    },
    { weight: 0, active: 0, motion: 0, rate: 0 },
  );
  const activeProbability = weighted.weight > 0 ? weighted.active / weighted.weight : 0;
  const motion = weighted.weight > 0 ? weighted.motion / weighted.weight : 0;
  const state =
    readyNodes.length === 0
      ? allNodes.some((node) => node.state === 'baseline')
        ? 'baseline'
        : 'waiting'
      : activeProbability >= 0.5
        ? 'active'
        : 'clear';
  const activeVotes = readyNodes.filter((node) => node.state === 'active').length;
  const clearVotes = readyNodes.filter((node) => node.state === 'clear').length;
  const disagreement =
    readyNodes.length > 0 ? Math.min(activeVotes, clearVotes) / readyNodes.length : 0;
  const baselineSamples = allNodes.reduce((sum, node) => sum + node.diagnostics.baselineSamples, 0);
  const baselineRequired = allNodes.reduce(
    (sum, node) => sum + node.diagnostics.baselineRequired,
    0,
  );
  const confidence =
    state === 'active' ? activeProbability : state === 'clear' ? 1 - activeProbability : 0;
  const profileNodes = readyNodes.length > 0 ? readyNodes : allNodes;
  const position = fusePositionEstimates(readyNodes);
  const modelTarget = readyNodes.find((node) => node.modelTarget === 'position')
    ? 'position'
    : readyNodes.find((node) => node.modelTarget)?.modelTarget;
  const bubbles =
    position?.accepted && position.x !== null && position.y !== null
      ? [
          {
            id: 'fused-position-estimate',
            x: position.x,
            y: position.y,
            radius: Number((0.07 + (1 - position.confidence) * 0.08).toFixed(4)),
            confidence: position.confidence,
            motion,
            zone: position.zone,
          },
        ]
      : [];

  return {
    timestamp: nowMs / 1000,
    state,
    confidence,
    motion,
    zone: position?.accepted ? position.zone : null,
    position,
    bubbles,
    amplitudeProfile: fuseAmplitudeProfile(profileNodes),
    frameRateHz: weighted.weight > 0 ? weighted.rate / weighted.weight : 0,
    lossPpm: readyNodes.length > 0 ? Math.max(...readyNodes.map((node) => node.lossPpm)) : 0,
    ageSec: readyNodes.length > 0 ? Math.max(...readyNodes.map((node) => node.ageSec ?? 0)) : null,
    deviceId: null,
    bootId: null,
    frames: readyNodes.reduce((sum, node) => sum + node.frames, 0),
    datagrams: allNodes.reduce((sum, node) => sum + node.datagrams, 0),
    invalidDatagrams: allNodes.reduce((sum, node) => sum + node.invalidDatagrams, 0),
    mode: 'fused',
    ...(modelTarget ? { modelTarget } : {}),
    scores: { active: activeProbability, clear: 1 - activeProbability },
    diagnostics: {
      baselineReady:
        allNodes.length > 0 && allNodes.every((node) => node.diagnostics.baselineReady),
      baselineSamples,
      baselineRequired,
      baselineProgress: baselineRequired > 0 ? Math.min(1, baselineSamples / baselineRequired) : 0,
      baselineMean: null,
      baselineDeviation: 0,
      activationScore: activeProbability,
      activeStreak: 0,
      clearStreak: 0,
    },
    source: 'real',
    ready: readinessReasons.length === 0,
    readinessReasons,
    contributingNodes: readyNodes.map((node) => node.deviceId ?? 'unknown'),
    disagreement,
  };
}

export function fusePositionEstimates(nodes: readonly DashboardState[]): PositionEstimate | null {
  const positionNodes = nodes.filter((node) => node.modelTarget === 'position');
  if (positionNodes.length === 0) return null;
  const accepted = positionNodes.filter(
    (node) =>
      node.position?.accepted &&
      node.position.zone &&
      node.position.x !== null &&
      node.position.y !== null,
  );
  if (accepted.length === 0) {
    return {
      accepted: false,
      zone: null,
      x: null,
      y: null,
      confidence: 0,
      margin: 0,
      contributors: 0,
      agreement: 0,
      reason: positionNodes.every((node) => node.state === 'clear')
        ? 'room classified as clear'
        : 'no receiver accepted a trained position',
    };
  }

  const votes = new Map<
    string,
    { weight: number; confidence: number; margin: number; x: number; y: number; contributors: number }
  >();
  for (const node of accepted) {
    const estimate = node.position!;
    const zone = estimate.zone!;
    const quality = Math.max(0.05, 1 - Math.min(1, node.lossPpm / 1_000_000));
    const weight = Math.max(0.01, estimate.confidence * quality);
    const vote = votes.get(zone) ?? {
      weight: 0,
      confidence: 0,
      margin: 0,
      x: 0,
      y: 0,
      contributors: 0,
    };
    vote.weight += weight;
    vote.confidence += estimate.confidence * weight;
    vote.margin += estimate.margin * weight;
    vote.x += estimate.x! * weight;
    vote.y += estimate.y! * weight;
    vote.contributors++;
    votes.set(zone, vote);
  }

  const ordered = [...votes.entries()].sort((left, right) => right[1].weight - left[1].weight);
  const [zone, winner] = ordered[0]!;
  const totalWeight = ordered.reduce((sum, [, vote]) => sum + vote.weight, 0) || 1;
  const agreement = winner.weight / totalWeight;
  const requiredContributors = Math.min(2, positionNodes.length);
  const isAccepted = winner.contributors >= requiredContributors && agreement >= 0.55;
  const reason =
    winner.contributors < requiredContributors
      ? `position needs ${requiredContributors} agreeing receivers`
      : agreement < 0.55
        ? 'receiver position votes do not agree'
        : null;

  return {
    accepted: isAccepted,
    zone: isAccepted ? zone : null,
    x: isAccepted ? winner.x / winner.weight : null,
    y: isAccepted ? winner.y / winner.weight : null,
    confidence: Math.max(0, Math.min(1, winner.confidence / winner.weight)),
    margin: Math.max(0, Math.min(1, winner.margin / winner.weight)),
    contributors: winner.contributors,
    agreement,
    reason,
  };
}

function fuseAmplitudeProfile(nodes: readonly DashboardState[]): number[] {
  const profiles = nodes
    .map((node) => node.amplitudeProfile)
    .filter((profile) => profile.length > 0);
  if (profiles.length === 0) return [];
  const width = Math.max(...profiles.map((profile) => profile.length));
  return Array.from({ length: width }, (_, column) => {
    const values = profiles
      .map((profile) => profile[column])
      .filter((value): value is number => Number.isFinite(value));
    if (values.length === 0) return 0;
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
  });
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
