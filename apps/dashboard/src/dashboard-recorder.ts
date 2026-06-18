import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CsiDatagram } from './protocol.js';

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
  datagrams: number;
  frames: number;
  bytes: number;
  binPath: string | null;
  jsonlPath: string | null;
  metaPath: string | null;
  error: string | null;
}

interface RecordingMeta {
  name: string;
  label: string;
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  stats: {
    datagrams: number;
    frames: number;
    bytes: number;
    targetSeconds: number;
    targetFrames: number;
  };
}

export class DashboardRecorder {
  private bin: WriteStream | null = null;
  private jsonl: WriteStream | null = null;
  private statusValue: RecordingStatus = {
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
    datagrams: 0,
    frames: 0,
    bytes: 0,
    binPath: null,
    jsonlPath: null,
    metaPath: null,
    error: null,
  };
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
      this.statusValue.elapsedSeconds = Number(elapsed.toFixed(1));
      this.statusValue.progress = Math.max(0, Math.min(1, Math.min(timeProgress, frameProgress)));
      this.statusValue.autoStopReady =
        this.statusValue.targetSeconds > 0 &&
        elapsed >= this.statusValue.targetSeconds &&
        this.statusValue.frames >= this.statusValue.targetFrames;
    }
    return { ...this.statusValue };
  }

  async start(label: string, targetSeconds = 90, targetFrames = 2000): Promise<RecordingStatus> {
    if (this.statusValue.active) throw new Error('recording already active');
    const cleanLabel = sanitizeLabel(label);
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
      active: true,
      label: cleanLabel,
      name,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      targetSeconds: safeTargetSeconds,
      targetFrames: safeTargetFrames,
      elapsedSeconds: 0,
      progress: 0,
      autoStopReady: false,
      datagrams: 0,
      frames: 0,
      bytes: 0,
      binPath,
      jsonlPath,
      metaPath,
      error: null,
    };
    await this.flushMeta(false);
    return this.status();
  }

  write(raw: Buffer, datagram: CsiDatagram, recvUnixMs: number): void {
    if (!this.bin || !this.jsonl || !this.statusValue.active) return;
    this.lenPrefix.writeUInt32LE(raw.length, 0);
    this.bin.write(Buffer.from(this.lenPrefix));
    this.bin.write(raw);
    const line = {
      recvUnixMs,
      deviceId: datagram.header.deviceId,
      bootId: datagram.header.bootId,
      packetSeq: datagram.header.packetSeq,
      flags: datagram.header.flags,
      frames: datagram.frames.map((frame) => ({
        frameSeq: frame.frameSeq,
        timestampUs: frame.timestampUs,
        rssi: frame.rssi,
        firstWordInvalid: frame.firstWordInvalid,
        csiLen: frame.csi.length,
        csiBase64: frame.csi.toString('base64'),
      })),
    };
    this.jsonl.write(`${JSON.stringify(line)}\n`);
    this.statusValue.datagrams++;
    this.statusValue.frames += datagram.frames.length;
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
    const meta: RecordingMeta = {
      name: this.statusValue.name,
      label: this.statusValue.label,
      startedAt: this.statusValue.startedAt ?? new Date().toISOString(),
      ...(this.statusValue.finishedAt ? { finishedAt: this.statusValue.finishedAt } : {}),
      complete,
      stats: {
        datagrams: this.statusValue.datagrams,
        frames: this.statusValue.frames,
        bytes: this.statusValue.bytes,
        targetSeconds: this.statusValue.targetSeconds,
        targetFrames: this.statusValue.targetFrames,
      },
    };
    await mkdir(dirname(this.statusValue.metaPath), { recursive: true });
    await writeFile(this.statusValue.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
}

function boundedInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function sanitizeLabel(label: string): string {
  const clean = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('recording label is required');
  return clean;
}

function endStream(stream: WriteStream | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!stream) return resolve();
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}
