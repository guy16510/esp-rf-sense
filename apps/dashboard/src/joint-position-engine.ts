import type { PositionEstimate } from './contracts.js';
import type { ContinuousXYPrediction } from './continuous-xy-model.js';
import { MultiNodeEngine, type MultiNodeOptions, type MultiNodeSnapshot } from './multi-node-engine.js';

export class JointPositionEngine extends MultiNodeEngine {
  private jointPosition: PositionEstimate | null | undefined;

  constructor(options: MultiNodeOptions = {}, private readonly roomWidthMeters = 4, private readonly roomHeightMeters = 4) {
    super(options);
  }

  setJointPrediction(prediction: ContinuousXYPrediction | null): void {
    if (prediction === null) {
      this.jointPosition = null;
      return;
    }
    const accepted = prediction.accepted && Number.isFinite(prediction.xMeters) && Number.isFinite(prediction.yMeters);
    const xNormalized = accepted
      ? prediction.xNormalized ?? clamp((prediction.xMeters ?? 0) / this.roomWidthMeters)
      : null;
    const yNormalized = accepted
      ? prediction.yNormalized ?? clamp((prediction.yMeters ?? 0) / this.roomHeightMeters)
      : null;
    this.jointPosition = {
      accepted,
      zone: null,
      x: xNormalized,
      y: yNormalized,
      xMeters: accepted ? prediction.xMeters : null,
      yMeters: accepted ? prediction.yMeters : null,
      xNormalized,
      yNormalized,
      uncertaintyMeters: prediction.uncertaintyMeters,
      receiverCount: prediction.receiverCount,
      packetOverlap: prediction.packetOverlap,
      confidence: accepted ? prediction.confidence : 0,
      margin: accepted && prediction.uncertaintyMeters !== null ? Math.max(0, 1 - prediction.uncertaintyMeters) : 0,
      contributors: prediction.receiverCount,
      agreement: prediction.packetOverlap,
      reason: prediction.reason,
    };
  }

  clearJointPrediction(): void {
    this.jointPosition = undefined;
  }

  override snapshot(nowMs = Date.now()): MultiNodeSnapshot {
    const snapshot = super.snapshot(nowMs);
    if (this.jointPosition === undefined) return snapshot;
    const position = this.jointPosition;
    return {
      ...snapshot,
      fused: {
        ...snapshot.fused,
        position,
        zone: position?.accepted ? position.zone : null,
        modelTarget: 'continuous-xy',
        bubbles: position?.accepted && position.x !== null && position.y !== null ? [{
          id: 'joint-xy-position', x: position.x, y: position.y,
          radius: 0.07 + (1 - position.confidence) * 0.08,
          confidence: position.confidence, motion: snapshot.fused.motion, zone: position.zone,
        }] : [],
      },
    };
  }
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
