import type {
  ActivityDiagnostics,
  ActivityState,
  PositionEstimate,
} from './contracts.js';
import { motionLevel, windowFeatures } from './features.js';
import type { PortablePrototypeModel } from './model.js';

export interface ActivityResult {
  state: ActivityState;
  confidence: number;
  motion: number;
  zone: string | null;
  position: PositionEstimate | null;
  mode: 'heuristic' | 'portable-model';
  modelTarget?: 'presence' | 'label' | 'position';
  scores: Record<string, number>;
  diagnostics: ActivityDiagnostics;
}

const REQUIRED = 20;

export class ActivityClassifier {
  private model: PortablePrototypeModel | undefined;
  private mean: number | null = null;
  private variance = 0;
  private samples = 0;
  private activeVotes = 0;
  private clearVotes = 0;
  private active = false;

  constructor(
    model?: PortablePrototypeModel,
    private readonly threshold?: number,
  ) {
    this.model = model;
  }

  setModel(model?: PortablePrototypeModel): void {
    this.model = model;
    this.activeVotes = 0;
    this.clearVotes = 0;
    this.active = false;
  }

  evaluate(frames: readonly Float64Array[]): ActivityResult {
    const motion = motionLevel(frames);
    if (frames.length < 2) return this.result('waiting', 0, motion, 0);

    if (this.model && frames.length >= this.model.bundle.window) {
      const prediction = this.model.predict(
        windowFeatures(frames.slice(-this.model.bundle.window)),
      );
      const clear = /empty|clear/iu.test(prediction.state);
      const activationScore = modelActivationScore(prediction.scores);
      const zonePoint = prediction.zone ? this.model.bundle.zones[prediction.zone] : undefined;
      const position: PositionEstimate | null =
        this.model.bundle.target === 'position'
          ? {
              accepted: !clear && prediction.accepted && Boolean(zonePoint),
              zone: !clear && prediction.accepted ? prediction.zone : null,
              x: !clear && prediction.accepted ? (zonePoint?.x ?? null) : null,
              y: !clear && prediction.accepted ? (zonePoint?.y ?? null) : null,
              confidence: prediction.confidence,
              margin: prediction.margin,
              contributors: 1,
              agreement: prediction.accepted ? 1 : 0,
              reason: clear ? 'room classified as clear' : prediction.reason,
            }
          : null;
      return {
        state: clear ? 'clear' : 'active',
        confidence: prediction.confidence,
        motion,
        zone: position?.zone ?? null,
        position,
        mode: 'portable-model',
        modelTarget: this.model.bundle.target,
        scores: prediction.scores,
        diagnostics: this.diagnostics(activationScore, true),
      };
    }

    if (this.threshold !== undefined) {
      const score = clamp(motion / (this.threshold * 2));
      this.active = score >= 0.5;
      return this.result(
        this.active ? 'active' : 'clear',
        this.active ? score : 1 - score,
        motion,
        score,
      );
    }

    if (this.samples < REQUIRED) {
      this.learn(motion, 0.18);
      this.samples++;
      return this.result('baseline', this.samples / REQUIRED, motion, 0);
    }

    const score = this.adaptiveScore(motion);
    if (score >= 0.65) {
      this.activeVotes++;
      this.clearVotes = 0;
    } else if (score <= 0.35) {
      this.clearVotes++;
      this.activeVotes = 0;
    }
    if (this.activeVotes >= 2) this.active = true;
    if (this.clearVotes >= 4) this.active = false;
    if (!this.active && score < 0.2) this.learn(motion, 0.025);

    return this.result(
      this.active ? 'active' : 'clear',
      this.active ? score : 1 - score,
      motion,
      score,
    );
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

  private result(
    state: ActivityState,
    confidence: number,
    motion: number,
    score: number,
  ): ActivityResult {
    return {
      state,
      confidence: clamp(confidence),
      motion,
      zone: null,
      position: null,
      mode: 'heuristic',
      scores: state === 'baseline' ? { learning: confidence } : { active: score, clear: 1 - score },
      diagnostics: this.diagnostics(
        score,
        this.threshold !== undefined || this.samples >= REQUIRED,
      ),
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

function modelActivationScore(scores: Record<string, number>): number {
  const entries = Object.entries(scores);
  if (entries.length === 0) return 0;
  const active = entries
    .filter(([label]) => !/empty|clear/iu.test(label))
    .reduce((sum, [, value]) => sum + value, 0);
  return clamp(active);
}
