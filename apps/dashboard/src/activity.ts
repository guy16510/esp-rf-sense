import type { ActivityState } from './contracts.js';
import { motionLevel, windowFeatures } from './features.js';
import type { PortablePrototypeModel } from './model.js';

export interface ActivityResult {
  state: ActivityState;
  confidence: number;
  motion: number;
  zone: string | null;
  mode: 'heuristic' | 'portable-model';
  scores: Record<string, number>;
}

export class ActivityClassifier {
  private baselineMean: number | null = null;
  private baselineVariance = 0;
  private baselineSamples = 0;

  constructor(
    private readonly model?: PortablePrototypeModel,
    private readonly motionThreshold?: number,
  ) {}

  evaluate(frames: readonly Float64Array[]): ActivityResult {
    const motion = motionLevel(frames);
    if (frames.length < 2) {
      return {
        state: 'waiting',
        confidence: 0,
        motion,
        zone: null,
        mode: 'heuristic',
        scores: {},
      };
    }
    if (this.model && frames.length >= this.model.bundle.window) {
      const features = windowFeatures(frames.slice(-this.model.bundle.window));
      const prediction = this.model.predict(features);
      const normalized = prediction.state.toLowerCase();
      const clear = normalized.includes('empty') || normalized.includes('clear');
      return {
        state: clear ? 'clear' : 'active',
        confidence: prediction.confidence,
        motion,
        zone: prediction.zone,
        mode: 'portable-model',
        scores: prediction.scores,
      };
    }
    return this.evaluateHeuristic(motion);
  }

  reset(): void {
    this.baselineMean = null;
    this.baselineVariance = 0;
    this.baselineSamples = 0;
  }

  private evaluateHeuristic(motion: number): ActivityResult {
    let activeProbability = 0;
    if (this.motionThreshold !== undefined) {
      activeProbability = Math.min(1, motion / Math.max(this.motionThreshold * 2, 1e-9));
    } else {
      if (this.baselineMean === null) this.baselineMean = motion;
      this.baselineSamples++;
      const deviation = Math.sqrt(Math.max(this.baselineVariance, 0));
      const z = deviation > 0 ? (motion - this.baselineMean) / deviation : 0;
      const meaningfulRise = motion > Math.max(this.baselineMean * 2, this.baselineMean + 1e-6);
      activeProbability = this.baselineSamples > 10 && meaningfulRise ? sigmoid(z - 3) : 0;
      if (activeProbability < 0.5) {
        const alpha = 0.05;
        const delta = motion - this.baselineMean;
        this.baselineMean += alpha * delta;
        this.baselineVariance = (1 - alpha) * (this.baselineVariance + alpha * delta * delta);
      }
    }
    const active = activeProbability >= 0.5;
    return {
      state: active ? 'active' : 'clear',
      confidence: active ? activeProbability : 1 - activeProbability,
      motion,
      zone: null,
      mode: 'heuristic',
      scores: { active: activeProbability, clear: 1 - activeProbability },
    };
  }
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
