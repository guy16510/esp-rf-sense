import { decodeAmplitude } from './features.js';
import { PING_SEQ_NONE, type CsiDatagram, type CsiFrame } from './protocol.js';
import { RingBuffer } from './ring-buffer.js';

export interface FrameSample {
  key: string;
  timestampUs: number;
  receivedAtMs: number;
  rssi: number;
  amplitude: Float64Array;
  streamKey: string;
}

export interface StreamShape {
  linkId: number;
  channel: number;
  bandwidth: number;
  phyMode: number;
  csiLength: number;
  subcarrierCount: number;
}

export interface InputBufferMetrics {
  datagrams: number;
  invalidDatagrams: number;
  parsedFrames: number;
  acceptedFrames: number;
  rollingWindowFrames: number;
  rejectedIncompatibleFrames: number;
  rejectedUncontrolledFrames: number;
  rejectedEmptyFrames: number;
  bufferResetCount: number;
  lastBufferResetReason: string | null;
  canonicalStreamKey: string | null;
  latestStreamKey: string | null;
  currentCsiShape: StreamShape | null;
}

export class InputBuffer {
  private readonly frames: RingBuffer<FrameSample>;
  private datagramCount = 0;
  private invalidCount = 0;
  private parsedFrameCount = 0;
  private acceptedFrameCount = 0;
  private rejectedIncompatibleFrameCount = 0;
  private rejectedUncontrolledFrameCount = 0;
  private rejectedEmptyFrameCount = 0;
  private bufferResetCount = 0;
  private lastBufferResetReason: string | null = null;
  private canonicalStreamKey: string | null = null;
  private latestStreamKey: string | null = null;
  private currentCsiShape: StreamShape | null = null;

  constructor(capacity: number) {
    this.frames = new RingBuffer(capacity);
  }

  recordInvalid(): void {
    this.invalidCount++;
  }

  accept(datagram: CsiDatagram, receivedAtMs: number): void {
    this.datagramCount++;
    for (const frame of datagram.frames) {
      this.parsedFrameCount++;
      const amplitude = decodeAmplitude(frame);
      if (amplitude.length === 0) {
        this.rejectedEmptyFrameCount++;
        continue;
      }
      const shape = streamShape(frame, amplitude.length);
      const key = streamKey(shape);
      this.latestStreamKey = key;
      const controlled = frame.pingSeq !== PING_SEQ_NONE;

      if (!this.canonicalStreamKey) {
        if (!controlled) {
          this.rejectedUncontrolledFrameCount++;
          continue;
        }
        this.canonicalStreamKey = key;
        this.currentCsiShape = shape;
      }

      if (key !== this.canonicalStreamKey) {
        if (controlled) this.rejectedIncompatibleFrameCount++;
        else this.rejectedUncontrolledFrameCount++;
        continue;
      }

      this.acceptedFrameCount++;
      this.frames.push({
        key: `${datagram.header.bootId}:${frame.frameSeq}`,
        timestampUs: frame.timestampUs,
        receivedAtMs,
        rssi: frame.rssi,
        amplitude,
        streamKey: key,
      });
    }
  }

  recent(limit: number): FrameSample[] {
    return this.frames.recent(limit);
  }

  resetWindow(reason: string): void {
    this.frames.clear();
    this.canonicalStreamKey = null;
    this.currentCsiShape = null;
    this.latestStreamKey = null;
    this.bufferResetCount++;
    this.lastBufferResetReason = reason;
  }

  metrics(): InputBufferMetrics {
    return {
      datagrams: this.datagramCount,
      invalidDatagrams: this.invalidCount,
      parsedFrames: this.parsedFrameCount,
      acceptedFrames: this.acceptedFrameCount,
      rollingWindowFrames: this.frames.length,
      rejectedIncompatibleFrames: this.rejectedIncompatibleFrameCount,
      rejectedUncontrolledFrames: this.rejectedUncontrolledFrameCount,
      rejectedEmptyFrames: this.rejectedEmptyFrameCount,
      bufferResetCount: this.bufferResetCount,
      lastBufferResetReason: this.lastBufferResetReason,
      canonicalStreamKey: this.canonicalStreamKey,
      latestStreamKey: this.latestStreamKey,
      currentCsiShape: this.currentCsiShape,
    };
  }
}

function streamShape(frame: CsiFrame, subcarrierCount: number): StreamShape {
  return {
    linkId: frame.linkId,
    channel: frame.channel,
    bandwidth: frame.bandwidth,
    phyMode: frame.phyMode,
    csiLength: frame.csiLen || frame.csi.length,
    subcarrierCount,
  };
}

function streamKey(shape: StreamShape): string {
  return [
    `link:${shape.linkId}`,
    `ch:${shape.channel}`,
    `bw:${shape.bandwidth}`,
    `phy:${shape.phyMode}`,
    `len:${shape.csiLength}`,
  ].join('|');
}
