import type { PositionEstimate } from './contracts.js';
import { MultiNodeEngine, type MultiNodeOptions, type MultiNodeSnapshot } from './multi-node-engine.js';
import type { XYPrediction } from './simulated-xy-pipeline.js';

export class JointPositionEngine extends MultiNodeEngine {
  private jointPosition: PositionEstimate | null | undefined;

  constructor(options: MultiNodeOptions = {}, private readonly roomWidthMeters = 4, private readonly roomHeightMeters = 4) {
    super(options);
  }

  setJointPrediction(prediction: XYPrediction | null): void {
    if (prediction === null) {
      this.jointPosition = null;
      return;
    }
    const accepted = prediction.accepted && Number.isFinite(prediction.xMeters) && Number.isFinite(prediction.yMeters);
    this.jointPosition = {
      accepted,
      zone: accepted ? 'continuous XY' : null,
      x: accepted ? clamp(prediction.xMeters / this.roomWidthMeters) : null,
      y: accepted ? clamp(prediction.yMeters / this.roomHeightMeters) : null,
      confidence: accepted ? clamp(1 - prediction.uncertaintyMeters / 1.5) : 0,
      margin: accepted ? Math.max(0, 1 - prediction.uncertaintyMeters) : 0,
      contributors: prediction.receiverCount,
      agreement: prediction.packetOverlap,
      reason: prediction.rejectionReason,
    };
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
        modelTarget: 'position',
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
