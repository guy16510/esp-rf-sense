// Per-(device, boot) sequence tracking: packet-loss estimation and reboot detection.
//
// packetSeq increments once per datagram for the life of a boot. A gap means loss; a reset to a
// low value under a *new* bootId means the device rebooted (expected, not loss). We never treat a
// reboot as loss, and we never silently merge two boots into one stream.
import { FLAG_MAINTENANCE } from './protocol.js';

export interface StreamKey {
  deviceId: number;
  bootId: number;
}

interface StreamState {
  firstPacketSeq: number;
  lastPacketSeq: number;
  received: number;
  framesReceived: number;
  lostEstimate: number;
  outOfOrder: number;
  duplicates: number;
  maintenanceDatagrams: number;
  firstRecvUnixMs: number;
  lastRecvUnixMs: number;
}

export interface CollectorStats {
  totalDatagrams: number;
  validDatagrams: number;
  invalidDatagrams: number;
  invalidReasons: Record<string, number>;
  reboots: number;
  streams: Array<StreamState & StreamKey & { lossPpm: number }>;
}

export class StreamTracker {
  private readonly streams = new Map<string, StreamState>();
  private readonly bootsByDevice = new Map<number, Set<number>>();
  totalDatagrams = 0;
  validDatagrams = 0;
  invalidDatagrams = 0;
  reboots = 0;
  readonly invalidReasons: Record<string, number> = {};

  private keyOf(k: StreamKey): string {
    return `${k.deviceId >>> 0}:${k.bootId >>> 0}`;
  }

  recordInvalid(reason: string): void {
    this.totalDatagrams++;
    this.invalidDatagrams++;
    this.invalidReasons[reason] = (this.invalidReasons[reason] ?? 0) + 1;
  }

  // Returns true if this datagram revealed a brand-new boot for the device (a reboot).
  record(
    k: StreamKey,
    packetSeq: number,
    frameCount: number,
    flags: number,
    recvUnixMs: number,
  ): {
    rebooted: boolean;
    gap: number;
  } {
    this.totalDatagrams++;
    this.validDatagrams++;

    let boots = this.bootsByDevice.get(k.deviceId);
    if (!boots) {
      boots = new Set();
      this.bootsByDevice.set(k.deviceId, boots);
    }
    let rebooted = false;
    if (!boots.has(k.bootId)) {
      if (boots.size > 0) {
        rebooted = true;
        this.reboots++;
      }
      boots.add(k.bootId);
    }

    const key = this.keyOf(k);
    let s = this.streams.get(key);
    let gap = 0;
    if (!s) {
      s = {
        firstPacketSeq: packetSeq,
        lastPacketSeq: packetSeq,
        received: 0,
        framesReceived: 0,
        lostEstimate: 0,
        outOfOrder: 0,
        duplicates: 0,
        maintenanceDatagrams: 0,
        firstRecvUnixMs: recvUnixMs,
        lastRecvUnixMs: recvUnixMs,
      };
      this.streams.set(key, s);
    } else {
      const delta = (packetSeq - s.lastPacketSeq) >>> 0;
      if (delta === 0) {
        s.duplicates++;
      } else if (delta > 0x7fffffff) {
        // Went backwards within the same boot: reordered datagram, not loss.
        s.outOfOrder++;
      } else {
        gap = delta - 1;
        s.lostEstimate += gap;
        s.lastPacketSeq = packetSeq;
      }
    }
    s.received++;
    s.framesReceived += frameCount;
    s.lastRecvUnixMs = recvUnixMs;
    if (flags & FLAG_MAINTENANCE) s.maintenanceDatagrams++;
    return { rebooted, gap };
  }

  snapshot(): CollectorStats {
    const streams = [...this.streams.entries()].map(([key, s]) => {
      const [deviceId, bootId] = key.split(':').map((n) => Number(n));
      const span = s.lastPacketSeq - s.firstPacketSeq + 1;
      const lossPpm = span > 0 ? Math.round((s.lostEstimate / span) * 1_000_000) : 0;
      return { deviceId: deviceId!, bootId: bootId!, ...s, lossPpm };
    });
    return {
      totalDatagrams: this.totalDatagrams,
      validDatagrams: this.validDatagrams,
      invalidDatagrams: this.invalidDatagrams,
      invalidReasons: this.invalidReasons,
      reboots: this.reboots,
      streams,
    };
  }
}
