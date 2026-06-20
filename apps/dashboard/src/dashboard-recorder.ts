import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureQuality } from './bar-calibration-algorithm.js';
import type { CsiDatagram } from './protocol.js';
import type { CsiFrameV2 } from './protocol-v2.js';

export interface RecordingStatus {
  active: boolean;
  label: string | null;
  name: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  targetSeconds: number;
  targetFrames: number;
  elapsedSeconds: number;
  progress: number;
  autoStopReady: boolean;
  adaptiveStopReady: boolean;
  qualityScore: number;
  qualityReasons: string[];
  uniqueBuckets: number;
  receiverCount: number;
  datagrams: number;
  frames: number;
  bytes: number;
  binPath: string | null;
  jsonlPath: string | null;
  metaPath: string | null;
  error: string | null;
}

interface PositionMetadata {
  label: string;
  x: number | null;
  y: number | null;
}

interface SupplementalMetadata {
  target?: 'label' | 'position' | 'continuous-xy';
  subjectId?: string;
  day?: string;
  movement?: string;
  recordingId?: string;
  xMeters?: number;
  yMeters?: number;
  orientationDegrees?: number;
  zoneAnnotation?: string;
  position?: PositionMetadata;
}

interface RecordingMeta extends SupplementalMetadata {
  name: string;
  label: string;
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  subject?: {
    id?: string;
    position?: PositionMetadata;
  };
  stats: {
    datagrams: number;
    frames: number;
    bytes: number;
    targetSeconds: number;
    targetFrames: number;
    adaptiveStopReady: boolean;
    qualityScore: number;
    uniqueBuckets: number;
    receiverCount: number;
  };
}

interface DecodedRecordingRequest {
  label: string;
  metadata: SupplementalMetadata;
}

const METADATA_PREFIX = 'rfsense-meta:';

export class DashboardRecorder {
  private bin: WriteStream | null = null;
  private jsonl: WriteStream | null = null;
  private supplementalMetadata: SupplementalMetadata = {};
  private readonly diversityBuckets = new Set<string>();
  private readonly receivers = new Set<string>();
  private statusValue: RecordingStatus = emptyStatus();
  private readonly lenPrefix = Buffer.alloc(4);

  constructor(private readonly outDir = 'recordings/dashboard') {}

  status(): RecordingStatus {
    if (this.statusValue.active && this.statusValue.startedAt) {
      const elapsed = Math.max(0, (Date.now() - Date.parse(this.statusValue.startedAt)) / 1000);
      const timeProgress =
        this.statusValue.targetSeconds > 0 ? elapsed / this.statusValue.targetSeconds : 0;
      const frameProgress =
        this.statusValue.targetFrames > 0
          ? this.statusValue.frames / this.statusValue.targetFrames
          : 0;
      const quality = captureQuality({
        elapsedSeconds: elapsed,
        frames: this.statusValue.frames,
        receiverCount: this.receivers.size,
        uniqueBuckets: this.diversityBuckets.size,
        invalidFraction: 0,
      });
      this.statusValue.elapsedSeconds = Number(elapsed.toFixed(1));
      this.statusValue.progress = Math.max(0, Math.min(1, Math.min(timeProgress, frameProgress)));
      this.statusValue.adaptiveStopReady = quality.stop;
      this.statusValue.qualityScore = Number(quality.score.toFixed(4));
      this.statusValue.qualityReasons = quality.reasons;
      this.statusValue.uniqueBuckets = this.diversityBuckets.size;
      this.statusValue.receiverCount = this.receivers.size;
      this.statusValue.autoStopReady =
        quality.stop ||
        (this.statusValue.targetSeconds > 0 &&
          elapsed >= this.statusValue.targetSeconds &&
          this.statusValue.frames >= this.statusValue.targetFrames);
    }
    return { ...this.statusValue, qualityReasons: [...this.statusValue.qualityReasons] };
  }

  async start(label: string, targetSeconds = 90, targetFrames = 2000): Promise<RecordingStatus> {
    if (this.statusValue.active) throw new Error('recording already active');
    const request = decodeRecordingRequest(label);
    const cleanLabel = sanitizeLabel(request.label);
    this.supplementalMetadata = request.metadata;
    this.diversityBuckets.clear();
    this.receivers.clear();
    const safeTargetSeconds = boundedInt(targetSeconds, 5, 3600);
    const safeTargetFrames = boundedInt(targetFrames, 1, 1_000_000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${cleanLabel}`;
    const binPath = join(this.outDir, `${name}.csi.bin`);
    const jsonlPath = join(this.outDir, `${name}.jsonl`);
    const metaPath = join(this.outDir, `${name}.meta.json`);
    await mkdir(this.outDir, { recursive: true });
    this.bin = createWriteStream(binPath);
    this.jsonl = createWriteStream(jsonlPath);
    this.statusValue = {
      ...emptyStatus(),
      active: true,
      label: cleanLabel,
      name,
      startedAt: new Date().toISOString(),
      targetSeconds: safeTargetSeconds,
      targetFrames: safeTargetFrames,
      binPath,
      jsonlPath,
      metaPath,
    };
    await this.flushMeta(false);
    return this.status();
  }

  write(raw: Buffer, datagram: CsiDatagram, recvUnixMs: number): void {
    if (!this.bin || !this.jsonl || !this.statusValue.active) return;
    this.lenPrefix.writeUInt32LE(raw.length, 0);
    this.bin.write(Buffer.from(this.lenPrefix));
    this.bin.write(raw);
    const receiver = (datagram.header.deviceId >>> 0).toString(16).padStart(8, '0');
    this.receivers.add(receiver);
    const line = {
      recvUnixMs,
      deviceId: datagram.header.deviceId,
      bootId: datagram.header.bootId,
      packetSeq: datagram.header.packetSeq,
      flags: datagram.header.flags,
      frames: datagram.frames.map((frame) => {
        this.diversityBuckets.add(diversityBucket(receiver, frame.rssi, frame.csi));
        return {
          frameSeq: frame.frameSeq,
          timestampUs: frame.timestampUs,
          rssi: frame.rssi,
          firstWordInvalid: frame.firstWordInvalid,
          csiLen: frame.csi.length,
          csiBase64: frame.csi.toString('base64'),
        };
      }),
    };
    this.jsonl.write(`${JSON.stringify(line)}\n`);
    this.statusValue.datagrams++;
    this.statusValue.frames += datagram.frames.length;
    this.statusValue.bytes += raw.length;
  }

  writeProtocolV2(
    raw: Buffer,
    frame: CsiFrameV2,
    source: { address: string; port: number },
    recvUnixMs: number,
  ): void {
    if (!this.bin || !this.jsonl || !this.statusValue.active) return;
    this.lenPrefix.writeUInt32LE(raw.length, 0);
    this.bin.write(Buffer.from(this.lenPrefix));
    this.bin.write(raw);
    const receiver = `${source.address}:${source.port}`;
    this.receivers.add(receiver);
    this.diversityBuckets.add(diversityBucket(receiver, frame.rssi, frame.csi));
    this.jsonl.write(
      `${JSON.stringify({
        protocolVersion: 2,
        recvUnixMs,
        source,
        receiverFrameSeq: frame.receiverFrameSeq,
        receiverTimestampUs: frame.receiverTimestampUs.toString(),
        transmitterId: frame.transmitterId,
        transmitterBootId: frame.transmitterBootId,
        transmitterPacketSeq: frame.transmitterPacketSeq,
        rssi: frame.rssi,
        noiseFloor: frame.noiseFloor,
        channel: frame.channel,
        bandwidthMhz: frame.bandwidthMhz,
        firstWordInvalid: frame.firstWordInvalid,
        csiLen: frame.csi.length,
        csiBase64: frame.csi.toString('base64'),
      })}\n`,
    );
    this.statusValue.datagrams++;
    this.statusValue.frames++;
    this.statusValue.bytes += raw.length;
  }

  shouldAutoStop(): boolean {
    return this.status().autoStopReady;
  }

  async stop(complete = true): Promise<RecordingStatus> {
    if (!this.statusValue.active) return this.status();
    this.statusValue.active = false;
    this.statusValue.finishedAt = new Date().toISOString();
    await Promise.all([endStream(this.bin), endStream(this.jsonl)]);
    this.bin = null;
    this.jsonl = null;
    await this.flushMeta(complete);
    return this.status();
  }

  private async flushMeta(complete: boolean): Promise<void> {
    if (!this.statusValue.metaPath || !this.statusValue.name || !this.statusValue.label) return;
    const position = this.supplementalMetadata.position;
    const subjectId = this.supplementalMetadata.subjectId;
    const meta: RecordingMeta = {
      name: this.statusValue.name,
      label: this.statusValue.label,
      startedAt: this.statusValue.startedAt ?? new Date().toISOString(),
      ...(this.statusValue.finishedAt ? { finishedAt: this.statusValue.finishedAt } : {}),
      complete,
      ...this.supplementalMetadata,
      ...(subjectId || position
        ? {
            subject: {
              ...(subjectId ? { id: subjectId } : {}),
              ...(position ? { position } : {}),
            },
          }
        : {}),
      stats: {
        datagrams: this.statusValue.datagrams,
        frames: this.statusValue.frames,
        bytes: this.statusValue.bytes,
        targetSeconds: this.statusValue.targetSeconds,
        targetFrames: this.statusValue.targetFrames,
        adaptiveStopReady: this.statusValue.adaptiveStopReady,
        qualityScore: this.statusValue.qualityScore,
        uniqueBuckets: this.statusValue.uniqueBuckets,
        receiverCount: this.statusValue.receiverCount,
      },
    };
    await mkdir(dirname(this.statusValue.metaPath), { recursive: true });
    await writeFile(this.statusValue.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
}

function emptyStatus(): RecordingStatus {
  return {
    active: false,
    label: null,
    name: null,
    startedAt: null,
    finishedAt: null,
    targetSeconds: 0,
    targetFrames: 0,
    elapsedSeconds: 0,
    progress: 0,
    autoStopReady: false,
    adaptiveStopReady: false,
    qualityScore: 0,
    qualityReasons: [],
    uniqueBuckets: 0,
    receiverCount: 0,
    datagrams: 0,
    frames: 0,
    bytes: 0,
    binPath: null,
    jsonlPath: null,
    metaPath: null,
    error: null,
  };
}

function diversityBucket(receiver: string, rssi: number, csi: Buffer): string {
  const digest = createHash('sha1').update(csi.subarray(0, 32)).digest('hex').slice(0, 6);
  return `${receiver}:${Math.round(rssi / 3)}:${digest}`;
}

function decodeRecordingRequest(value: string): DecodedRecordingRequest {
  if (!value.startsWith(METADATA_PREFIX)) return { label: value, metadata: {} };
  const encoded = value.slice(METADATA_PREFIX.length);
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SupplementalMetadata & {
      label?: string;
    };
    const label = String(parsed.label ?? '').trim();
    if (!label) throw new Error('metadata label is required');
    const { label: _label, ...metadata } = parsed;
    return { label, metadata };
  } catch (error) {
    throw new Error(`invalid recording metadata: ${(error as Error).message}`);
  }
}

function sanitizeLabel(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!clean) throw new Error('recording label is required');
  return clean.slice(0, 80);
}

function boundedInt(value: number, minimum: number, maximum: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : minimum;
}

async function endStream(stream: WriteStream | null): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}
