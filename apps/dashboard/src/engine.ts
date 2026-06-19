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
  private input: InputBuffer;
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
    this.input = new InputBuffer(this.windowFrames * 8);
    this.classifier.reset();
    this.latestKey = null;
    this.latestResult = this.classifier.evaluate([]);
  }

  setModel(model?: PortablePrototypeModel): void {
    this.classifier.setModel(model);
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
    const position = this.latestResult.position;
    const bubbles =
      position?.accepted && position.x !== null && position.y !== null
        ? [
            {
              id: 'position-estimate',
              x: position.x,
              y: position.y,
              radius: Number((0.08 + (1 - position.confidence) * 0.08).toFixed(4)),
              confidence: position.confidence,
              motion: this.latestResult.motion,
              zone: position.zone,
            },
          ]
        : [];
    return {
      timestamp: nowMs / 1000,
      ...this.latestResult,
      bubbles,
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

function frameRate(frames: readonly { receivedAtMs: number }[]): number {
  if (frames.length < 2) return 0;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return 0;
  const spanMs = last.receivedAtMs - first.receivedAtMs;
  return spanMs > 0 ? Number((((frames.length - 1) * 1000) / spanMs).toFixed(1)) : 0;
}
