import type { DashboardState } from './contracts.js';
import { amplitudeProfile, decodeAmplitude, motionLevel } from './numeric-features.js';
import type { CsiDatagram } from './protocol.js';
import { RingBuffer } from './ring-buffer.js';

interface Sample {
  timestampUs: number;
  receivedAtMs: number;
  amplitude: Float64Array;
  rssi: number;
}

export class NodeEngine {
  private readonly samples: RingBuffer<Sample>;
  private datagrams = 0;
  private invalidDatagrams = 0;
  private baselineMean: number | null = null;
  private baselineVariance = 0;
  private baselineSamples = 0;
  private deviceId: number | null = null;
  private bootId: number | null = null;
  private lastPacketSeq: number | null = null;
  private missingPackets = 0;
  private csiLength = 0;

  constructor(
    private readonly windowFrames = 64,
    private readonly threshold?: number,
  ) {
    this.samples = new RingBuffer(Math.max(windowFrames * 8, 256));
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.datagrams++;
    this.deviceId = datagram.header.deviceId;
    if (this.bootId !== null && this.bootId !== datagram.header.bootId) {
      this.lastPacketSeq = null;
    }
    this.bootId = datagram.header.bootId;
    if (this.lastPacketSeq !== null && datagram.header.packetSeq > this.lastPacketSeq + 1) {
      this.missingPackets += datagram.header.packetSeq - this.lastPacketSeq - 1;
    }
    this.lastPacketSeq = datagram.header.packetSeq;

    for (const frame of datagram.frames) {
      const amplitude = decodeAmplitude(frame);
      if (amplitude.length === 0) continue;
      this.csiLength = frame.csi.length;
      this.samples.push({
        timestampUs: frame.timestampUs,
        receivedAtMs,
        amplitude,
        rssi: frame.rssi,
      });
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
    const totalPackets = this.datagrams + this.missingPackets;
    const lossPpm = totalPackets > 0 ? Math.round((this.missingPackets / totalPackets) * 1_000_000) : 0;
    const averageRssi = samples.length
      ? samples.reduce((total, sample) => total + sample.rssi, 0) / samples.length
      : null;

    return {
      timestamp: nowMs / 1000,
      state: samples.length < 2 ? 'waiting' : active ? 'active' : 'clear',
      confidence: samples.length < 2 ? 0 : confidence,
      motion,
      zone: null,
      bubbles: [],
      amplitudeProfile: amplitudeProfile(amplitudes),
      frameRateHz: frameRate(samples),
      lossPpm,
      ageSec: latest ? Math.max(0, (nowMs - latest.receivedAtMs) / 1000) : null,
      deviceId: this.deviceId === null ? null : String(this.deviceId),
      bootId: this.bootId === null ? null : String(this.bootId),
      frames: samples.length,
      datagrams: this.datagrams,
      invalidDatagrams: this.invalidDatagrams,
      mode: 'heuristic',
      scores: { active: activeProbability, clear: 1 - activeProbability },
      source: 'real',
      averageRssi,
      csiLength: this.csiLength,
      subcarrierCount: this.csiLength > 0 ? Math.floor(this.csiLength / 2) : 0,
      missingPackets: this.missingPackets,
      ready:
        samples.length >= 2 &&
        latest !== undefined &&
        nowMs - latest.receivedAtMs <= 3000 &&
        this.csiLength > 0,
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
