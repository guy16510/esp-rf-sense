// UDP CSI collector. Binds a socket, validates every datagram, tracks loss/reboots, and records
// raw + decoded frames. It never blocks the socket on disk I/O beyond the Node stream buffers and
// never alters CSI bytes. Designed to run unattended for long captures.
import { createSocket, type Socket } from 'node:dgram';

import { parseDatagram } from './protocol.js';
import { RecordingWriter } from './recording.js';
import { StreamTracker } from './stats.js';

export interface CollectorOptions {
  port: number;
  host?: string; // bind address; defaults to all interfaces
  outDir: string;
  name: string;
  experiment?: Record<string, unknown>;
  onStatus?: (line: string) => void;
}

export class Collector {
  private socket: Socket | null = null;
  private readonly tracker = new StreamTracker();
  private readonly writer: RecordingWriter;
  private closing = false;

  constructor(private readonly opts: CollectorOptions) {
    this.writer = new RecordingWriter(opts.outDir, opts.name, opts.experiment);
  }

  async start(): Promise<void> {
    await this.writer.open();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg) => this.onMessage(msg));
    socket.on('error', (err) => {
      this.log(`socket error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.opts.port, this.opts.host, () => {
        socket.removeListener('error', reject);
        const a = socket.address();
        this.log(`listening on ${a.address}:${a.port} -> ${this.opts.outDir}/${this.opts.name}`);
        resolve();
      });
    });
  }

  private onMessage(msg: Buffer): void {
    const recvUnixMs = Date.now();
    const result = parseDatagram(msg);
    if (!result.ok) {
      this.tracker.recordInvalid(result.error);
      return;
    }
    const { header, frames } = result.datagram;
    const { rebooted, gap } = this.tracker.record(
      { deviceId: header.deviceId, bootId: header.bootId },
      header.packetSeq,
      header.frameCount,
      header.flags,
      recvUnixMs,
    );
    if (rebooted) {
      this.log(
        `device ${hex(header.deviceId)} rebooted (new bootId ${hex(header.bootId)}) -- stream continues`,
      );
    }
    if (gap > 0) {
      this.log(`loss: ${gap} datagram(s) missing before packetSeq ${header.packetSeq}`);
    }
    this.writer.write(msg, result.datagram, recvUnixMs);
    void frames;
  }

  stats() {
    return this.tracker.snapshot();
  }

  // Marks the recording complete=true on a clean stop, false if interrupted/aborted.
  async stop(complete = true, note?: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (note) this.writer.setNote(note);
    if (this.socket) {
      await new Promise<void>((resolve) => this.socket!.close(() => resolve()));
      this.socket = null;
    }
    await this.writer.close(this.tracker.snapshot(), complete);
    this.log(complete ? 'recording closed cleanly' : 'recording marked INCOMPLETE');
  }

  private log(line: string): void {
    if (this.opts.onStatus) this.opts.onStatus(line);
    else console.error(`[collector] ${line}`);
  }
}

function hex(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
}
