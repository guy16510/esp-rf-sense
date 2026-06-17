import type { DashboardState } from './contracts.js';
import { amplitudeProfile, decodeAmplitude, motionLevel } from './numeric-features.js';
import type { CsiDatagram } from './protocol.js';
import { RingBuffer } from './ring-buffer.js';

interface Sample {
  timestampUs: number;
  receivedAtMs: number;
  amplitude: Float64Array;
}

export class NodeEngine {
  private readonly samples: RingBuffer<Sample>;
  private datagrams = 0;
  private invalidDatagrams = 0;
  private baselineMean: number | null = null;
  private baselineVariance = 0;
  private baselineSamples = 0;

  constructor(
    private readonly windowFrames = 64,
    private readonly threshold?: number,
  ) {
    this.samples = new RingBuffer(Math.max(windowFrames * 8, 256));
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.datagrams++;
    for (const frame of datagram.frames) {
      const amplitude = decodeAmplitude(frame);
      if (amplitude.length === 0) continue;
      this.samples.push({ timestampUs: frame.timestampUs, receivedAtMs, amplitude });
    }
  }

  recordInvalid(): void {
    this.invalidDatagrams++;
  }

  snapshot(nowMs = Date.now()): DashboardState {
    const samples = this.samples.recent(this.windowFrames);
    const amplitudes = samples.map((sample) => sample.amplitude);
    const motion = motionLevel(amplitudes);
    const activeProbability = this.activityProbability(motion);
    const active = activeProbability >= 0.5;
    const latest = samples.at(-1);
    const confidence = active ? activeProbability : 1 - activeProbability;
    return {
      timestamp: nowMs / 1000,
      state: samples.length < 2 ? 'waiting' : active ? 'active' : 'clear',
      confidence: samples.length < 2 ? 0 : confidence,
      motion,
      zone: null,
      bubbles: active
        ? [
            {
              id: 'activity-0',
              x: 0.5,
              y: 0.5,
              radius: 0.08 + confidence * 0.08,
              confidence,
              motion,
              zone: null,
            },
          ]
        : [],
      amplitudeProfile: amplitudeProfile(amplitudes),
      frameRateHz: frameRate(samples),
      lossPpm: 0,
      ageSec: latest ? Math.max(0, (nowMs - latest.receivedAtMs) / 1000) : null,
      deviceId: null,
      bootId: null,
      frames: samples.length,
      datagrams: this.datagrams,
      invalidDatagrams: this.invalidDatagrams,
      mode: 'heuristic',
      scores: { active: activeProbability, clear: 1 - activeProbability },
    };
  }

  private activityProbability(motion: number): number {
    if (this.threshold !== undefined)
      return Math.min(1, motion / Math.max(this.threshold * 2, 1e-9));
    if (this.baselineMean === null) this.baselineMean = motion;
    this.baselineSamples++;
    const deviation = Math.sqrt(Math.max(this.baselineVariance, 0));
    const z = deviation > 0 ? (motion - this.baselineMean) / deviation : 0;
    const meaningfulRise = motion > Math.max(this.baselineMean * 2, this.baselineMean + 1e-6);
    const probability =
      this.baselineSamples > 10 && meaningfulRise ? 1 / (1 + Math.exp(-(z - 3))) : 0;
    if (probability < 0.5) {
      const alpha = 0.05;
      const delta = motion - this.baselineMean;
      this.baselineMean += alpha * delta;
      this.baselineVariance = (1 - alpha) * (this.baselineVariance + alpha * delta * delta);
    }
    return probability;
  }
}

function frameRate(samples: readonly Sample[]): number {
  if (samples.length < 2) return 0;
  const spanUs = samples.at(-1)!.timestampUs - samples[0]!.timestampUs;
  return spanUs > 0 ? Number((((samples.length - 1) * 1_000_000) / spanUs).toFixed(1)) : 0;
}
