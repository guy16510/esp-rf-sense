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
  private latestResult = new ActivityClassifier().evaluate([]);

  constructor(options: EngineOptions = {}) {
    this.windowFrames = Math.max(8, Math.floor(options.windowFrames ?? 64));
    this.input = new InputBuffer(this.windowFrames * 8);
    this.classifier = new ActivityClassifier(options.model, options.motionThreshold);
    this.latestResult = this.classifier.evaluate([]);
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.input.accept(datagram, receivedAtMs);
  }

  recordInvalid(): void {
    this.input.recordInvalid();
  }

  resetBaseline(): void {
    this.classifier.reset();
    this.latestKey = null;
    this.latestResult = this.classifier.evaluate([]);
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
              id: 'rf-disturbance',
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
}

function frameRate(frames: readonly { timestampUs: number }[]): number {
  if (frames.length < 2) return 0;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return 0;
  const spanUs = last.timestampUs - first.timestampUs;
  return spanUs > 0 ? Number((((frames.length - 1) * 1000000) / spanUs).toFixed(1)) : 0;
}
