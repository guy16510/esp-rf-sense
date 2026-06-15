import { decodeAmplitude } from './features.js';
import type { CsiDatagram } from './protocol.js';
import { RingBuffer } from './ring-buffer.js';

export interface FrameSample {
  key: string;
  timestampUs: number;
  receivedAtMs: number;
  amplitude: Float64Array;
}

export class InputBuffer {
  private readonly frames: RingBuffer<FrameSample>;
  private subcarrierCount = 0;
  private datagramCount = 0;
  private invalidCount = 0;

  constructor(capacity: number) {
    this.frames = new RingBuffer(capacity);
  }

  recordInvalid(): void {
    this.invalidCount++;
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.datagramCount++;
    for (const frame of datagram.frames) {
      const amplitude = decodeAmplitude(frame);
      if (amplitude.length === 0) continue;
      if (this.subcarrierCount === 0) this.subcarrierCount = amplitude.length;
      if (amplitude.length !== this.subcarrierCount) continue;
      this.frames.push({
        key: `${datagram.header.bootId}:${frame.frameSeq}`,
        timestampUs: frame.timestampUs,
        receivedAtMs,
        amplitude,
      });
    }
  }

  recent(limit: number): FrameSample[] {
    return this.frames.recent(limit);
  }

  metrics(): { datagrams: number; invalidDatagrams: number } {
    return { datagrams: this.datagramCount, invalidDatagrams: this.invalidCount };
  }
}
