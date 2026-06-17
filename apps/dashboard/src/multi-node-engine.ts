import type { DashboardState, MultiNodeState } from './contracts.js';
import { NodeEngine } from './node-engine.js';
import type { CsiDatagram } from './protocol.js';

export class MultiNodeEngine {
  private readonly nodes = new Map<number, NodeEngine>();
  private invalidDatagrams = 0;

  constructor(
    private readonly windowFrames = 64,
    private readonly threshold?: number,
    private readonly requiredNodeCount = 4,
  ) {}

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    let engine = this.nodes.get(datagram.header.deviceId);
    if (!engine) {
      engine = new NodeEngine(this.windowFrames, this.threshold);
      this.nodes.set(datagram.header.deviceId, engine);
    }
    engine.accept(datagram, receivedAtMs);
  }

  recordInvalid(): void {
    this.invalidDatagrams++;
  }

  nodeSnapshots(nowMs = Date.now()): DashboardState[] {
    return [...this.nodes.values()]
      .map((engine) => engine.snapshot(nowMs))
      .sort((a, b) => Number(a.deviceId ?? 0) - Number(b.deviceId ?? 0));
  }

  snapshot(nowMs = Date.now()): MultiNodeState {
    const nodes = this.nodeSnapshots(nowMs);
    const usable = nodes.filter((node) => node.ready && node.source === 'real');
    const excludedNodes = nodes
      .filter((node) => !node.ready)
      .map((node) => ({
        deviceId: node.deviceId ?? 'unknown',
        reason: node.ageSec === null ? 'no frames received' : `last frame ${node.ageSec.toFixed(1)}s ago`,
      }));

    const weighted = usable.reduce(
      (acc, node) => {
        const weight = Math.max(0.05, 1 - Math.min(1, node.lossPpm / 1_000_000));
        acc.totalWeight += weight;
        acc.active += node.scores.active * weight;
        acc.motion += node.motion * weight;
        return acc;
      },
      { totalWeight: 0, active: 0, motion: 0 },
    );

    const activeProbability =
      weighted.totalWeight > 0 ? weighted.active / weighted.totalWeight : null;
    const motion = weighted.totalWeight > 0 ? weighted.motion / weighted.totalWeight : 0;
    const activeVotes = usable.filter((node) => node.state === 'active').length;
    const clearVotes = usable.filter((node) => node.state === 'clear').length;
    const disagreement = usable.length > 0 ? Math.min(activeVotes, clearVotes) / usable.length : 0;
    const state =
      activeProbability === null ? 'waiting' : activeProbability >= 0.5 ? 'active' : 'clear';

    const reasons: string[] = [];
    if (nodes.length < this.requiredNodeCount) {
      reasons.push(`discovered ${nodes.length} of ${this.requiredNodeCount} required nodes`);
    }
    if (usable.length < this.requiredNodeCount) {
      reasons.push(`${usable.length} of ${this.requiredNodeCount} required nodes are receiving fresh real CSI`);
    }
    if (this.invalidDatagrams > 0) reasons.push(`${this.invalidDatagrams} malformed datagrams observed`);

    return {
      timestamp: nowMs / 1000,
      source: 'real',
      readiness: {
        source: 'real',
        readyForCapture: usable.length >= this.requiredNodeCount,
        requiredNodeCount: this.requiredNodeCount,
        onlineNodeCount: usable.length,
        reasons,
      },
      nodes,
      fused: {
        state,
        confidence:
          activeProbability === null
            ? null
            : state === 'active'
              ? activeProbability
              : 1 - activeProbability,
        motion,
        contributingNodes: usable.map((node) => node.deviceId ?? 'unknown'),
        excludedNodes,
        disagreement,
      },
    };
  }
}
