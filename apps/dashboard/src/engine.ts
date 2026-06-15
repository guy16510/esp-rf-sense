import type { DashboardState } from './contracts.js';
import { amplitudeProfile } from './features.js';
import { ActivityClassifier } from './activity.js';
import { InputBuffer } from './input-buffer.js';
import type { PortablePrototypeModel } from './model.js';
import type { CsiDatagram } from './protocol.js';

export interface EngineOptions {
  windowFrames?: number;
  motionThreshold?: number;
  model?: PortablePrototypeModel;
}

export class RealtimeEngine {
  private readonly windowFrames: number;
  private readonly input: InputBuffer;
  private readonly classifier: ActivityClassifier;
  private latestKey: string | null = null;
  private latestResult = this.classifierResultWaiting();

  constructor(options: EngineOptions = {}) {
    this.windowFrames = Math.max(8, Math.floor(options.windowFrames ?? 64));
    this.input = new InputBuffer(this.windowFrames * 8);
    this.classifier = new ActivityClassifier(options.model, options.motionThreshold);
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.input.accept(datagram, receivedAtMs);
  }

  recordInvalid(): void {
    this.input.recordInvalid();
  }

  snapshot(nowMs = Date.now()): DashboardState {
    const frames = this.input.recent(this.windowFrames);
    const latest = frames.at(-1);
    if (latest && latest.key !== this.latestKey) {
      this.latestKey = latest.key;
      this.latestResult = this.classifier.evaluate(frames.map((frame) => frame.amplitude));
    }
    const metrics = this.input.metrics();
    const ageSec = latest ? Math.max(0, (nowMs - latest.receivedAtMs) / 1000) : null;
    const active = this.latestResult.state === 'active';
    return {
      timestamp: nowMs / 1000,
      ...this.latestResult,
      bubbles: active
        ? [
            {
              id: 'activity-0',
              x: 0.5,
              y: 0.5,
              radius: Number((0.08 + this.latestResult.confidence * 0.08).toFixed(4)),
              confidence: this.latestResult.confidence,
              motion: this.latestResult.motion,
              zone: this.latestResult.zone,
            },
          ]
        : [],
      amplitudeProfile: amplitudeProfile(frames.map((frame) => frame.amplitude)),
      frameRateHz: frameRate(frames),
      lossPpm: 0,
      ageSec,
      deviceId: null,
      bootId: null,
      frames: frames.length,
      datagrams: metrics.datagrams,
      invalidDatagrams: metrics.invalidDatagrams,
    };
  }

  private classifierResultWaiting() {
    return {
      state: 'waiting' as const,
      confidence: 0,
      motion: 0,
      zone: null,
      mode: 'heuristic' as const,
      scores: {} as Record<string, number>,
    };
  }
}

function frameRate(frames: readonly { timestampUs: number }[]): number {
  if (frames.length < 2) return 0;
  const spanUs = frames.at(-1)!.timestampUs - frames[0]!.timestampUs;
  return spanUs > 0 ? Number((((frames.length - 1) * 1_000_000) / spanUs).toFixed(1)) : 0;
}
