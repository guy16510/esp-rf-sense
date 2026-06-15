// Writes a CSI recording to disk in three coordinated files:
//   <name>.csi.bin   raw datagrams, length-prefixed (u32 LE) -- the authoritative, unaltered bytes
//   <name>.jsonl     one decoded datagram per line (CSI as base64) -- convenient for analysis
//   <name>.meta.json metadata + final statistics; "complete": false until close() runs cleanly
//
// The binary file is the source of truth: the analysis pipeline re-parses it so a bug in the
// JSONL encoder can never silently corrupt the dataset. Raw CSI is copied verbatim, never scaled.
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Datagram } from './protocol.js';

export interface RecordingMeta {
  name: string;
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  note?: string;
  experiment?: Record<string, unknown>;
  stats?: unknown;
}

export class RecordingWriter {
  private readonly binPath: string;
  private readonly jsonlPath: string;
  private readonly metaPath: string;
  private bin: WriteStream | null = null;
  private jsonl: WriteStream | null = null;
  private readonly meta: RecordingMeta;
  private readonly lenPrefix = Buffer.alloc(4);

  constructor(
    private readonly dir: string,
    name: string,
    experiment?: Record<string, unknown>,
  ) {
    this.binPath = join(dir, `${name}.csi.bin`);
    this.jsonlPath = join(dir, `${name}.jsonl`);
    this.metaPath = join(dir, `${name}.meta.json`);
    this.meta = {
      name,
      startedAt: new Date().toISOString(),
      complete: false,
      ...(experiment ? { experiment } : {}),
    };
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.bin = createWriteStream(this.binPath);
    this.jsonl = createWriteStream(this.jsonlPath);
    // Persist an incomplete marker up front so an interrupted run is recognizable.
    await this.flushMeta();
  }

  // Records a datagram. `raw` is the exact bytes received; `dg` is the decoded view.
  write(raw: Buffer, dg: Datagram, recvUnixMs: number): void {
    if (!this.bin || !this.jsonl) throw new Error('recording not open');
    this.lenPrefix.writeUInt32LE(raw.length, 0);
    this.bin.write(Buffer.from(this.lenPrefix));
    this.bin.write(raw);

    const line = {
      recvUnixMs,
      deviceId: dg.header.deviceId,
      bootId: dg.header.bootId,
      packetSeq: dg.header.packetSeq,
      batchSeq: dg.header.batchSeq,
      captureMode: dg.header.captureMode,
      flags: dg.header.flags,
      frames: dg.frames.map((f) => ({
        frameSeq: f.frameSeq,
        timestampUs: f.timestampUs,
        pingSeq: f.pingSeq,
        rssi: f.rssi,
        noiseFloor: f.noiseFloor,
        channel: f.channel,
        secondaryChannel: f.secondaryChannel,
        bandwidth: f.bandwidth,
        phyMode: f.phyMode,
        rate: f.rate,
        firstWordInvalid: f.firstWordInvalid,
        linkId: f.linkId,
        csiLen: f.csiLen,
        csiBase64: f.csi.toString('base64'),
      })),
    };
    this.jsonl.write(`${JSON.stringify(line)}\n`);
  }

  setNote(note: string): void {
    this.meta.note = note;
  }

  async close(stats: unknown, complete: boolean): Promise<void> {
    this.meta.finishedAt = new Date().toISOString();
    this.meta.complete = complete;
    this.meta.stats = stats;
    await Promise.all([endStream(this.bin), endStream(this.jsonl)]);
    this.bin = null;
    this.jsonl = null;
    await this.flushMeta();
  }

  private async flushMeta(): Promise<void> {
    await mkdir(dirname(this.metaPath), { recursive: true });
    await writeFile(this.metaPath, `${JSON.stringify(this.meta, null, 2)}\n`);
  }
}

function endStream(s: WriteStream | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!s) return resolve();
    s.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}
