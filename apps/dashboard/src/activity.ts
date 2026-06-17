import type { ActivityDiagnostics, ActivityState } from './contracts.js';
import { motionLevel, windowFeatures } from './features.js';
import type { PortablePrototypeModel } from './model.js';

export interface ActivityResult {
  state: ActivityState;
  confidence: number;
  motion: number;
  zone: string | null;
  mode: 'heuristic' | 'portable-model';
  scores: Record<string, number>;
  diagnostics: ActivityDiagnostics;
}

const REQUIRED = 20;

export class ActivityClassifier {
  private mean: number | null = null;
  private variance = 0;
  private samples = 0;
  private activeVotes = 0;
  private clearVotes = 0;
  private active = false;

  constructor(
    private readonly model?: PortablePrototypeModel,
    private readonly threshold?: number,
  ) {}

  evaluate(frames: readonly Float64Array[]): ActivityResult {
    const motion = motionLevel(frames);
    if (frames.length < 2) return this.result('waiting', 0, motion, 0);

    if (this.model && frames.length >= this.model.bundle.window) {
      const prediction = this.model.predict(windowFeatures(frames.slice(-this.model.bundle.window)));
      const clear = /empty|clear/iu.test(prediction.state);
      return {
        state: clear ? 'clear' : 'active',
        confidence: prediction.confidence,
        motion,
        zone: prediction.zone,
        mode: 'portable-model',
        scores: prediction.scores,
        diagnostics: this.diagnostics(1, true),
      };
    }

    if (this.threshold === undefined && this.samples < REQUIRED) {
      this.learn(motion, 0.18);
      this.samples++;
      return this.result('baseline', this.samples / REQUIRED, motion, 0);
    }

    const score = this.threshold === undefined
      ? this.adaptiveScore(motion)
      : clamp(motion / (this.threshold * 2));

    if (score >= 0.65) {
      this.activeVotes++;
      this.clearVotes = 0;
    } else if (score <= 0.35) {
      this.clearVotes++;
      this.activeVotes = 0;
    }
    if (this.activeVotes >= 2) this.active = true;
    if (this.clearVotes >= 4) this.active = false;
    if (!this.active && score < 0.2 && this.threshold === undefined) this.learn(motion, 0.025);

    return this.result(this.active ? 'active' : 'clear', this.active ? score : 1 - score, motion, score);
  }

  reset(): void {
    this.mean = null;
    this.variance = 0;
    this.samples = 0;
    this.activeVotes = 0;
    this.clearVotes = 0;
    this.active = false;
  }

  private adaptiveScore(motion: number): number {
    const mean = this.mean ?? motion;
    const deviation = Math.sqrt(Math.max(this.variance, 0.000000000001));
    if (motion <= Math.max(mean * 1.8, mean + 0.000001)) return 0;
    return clamp(1 / (1 + Math.exp(-((motion - mean) / deviation - 2.75))));
  }

  private learn(value: number, alpha: number): void {
    if (this.mean === null) this.mean = value;
    const delta = value - this.mean;
    this.mean += alpha * delta;
    this.variance = (1 - alpha) * (this.variance + alpha * delta * delta);
  }

  private result(state: ActivityState, confidence: number, motion: number, score: number): ActivityResult {
    return {
      state,
      confidence: clamp(confidence),
      motion,
      zone: null,
      mode: 'heuristic',
      scores: state === 'baseline' ? { learning: confidence } : { active: score, clear: 1 - score },
      diagnostics: this.diagnostics(score, this.threshold !== undefined || this.samples >= REQUIRED),
    };
  }

  private diagnostics(score: number, ready: boolean): ActivityDiagnostics {
    return {
      baselineReady: ready,
      baselineSamples: this.samples,
      baselineRequired: REQUIRED,
      baselineProgress: ready ? 1 : this.samples / REQUIRED,
      baselineMean: this.mean,
      baselineDeviation: Math.sqrt(Math.max(this.variance, 0)),
      activationScore: clamp(score),
      activeStreak: this.activeVotes,
      clearStreak: this.clearVotes,
    };
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
