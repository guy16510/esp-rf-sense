export type ReceiverSlot = "A" | "B" | "C" | "D";

export interface ReceiverObservation {
  receiverSlot: ReceiverSlot;
  receiverDeviceId: string;
  receiverBootId: string;
  receiverFrameSeq: number;
  receiverTimestampUs: number;
  transmitterId: string;
  transmitterBootId: string;
  transmitterPacketSeq: number;
  rssi: number;
  noiseFloor?: number;
  channel: number;
  bandwidthMhz: number;
  firstWordInvalid: boolean;
  csi: Uint8Array;
  receivedAtMs: number;
}

export interface AlignedPacket {
  transmitterId: string;
  transmitterBootId: string;
  transmitterPacketSeq: number;
  observations: Record<ReceiverSlot, ReceiverObservation | null>;
  receiverCount: number;
  complete: boolean;
  firstReceivedAtMs: number;
  finalizedAtMs: number;
}

export interface AlignmentMetrics {
  packetsReceivedByReceiver: Record<ReceiverSlot, number>;
  alignedPacketCount: number;
  fourOfFourCount: number;
  threeOfFourCount: number;
  twoOrFewerCount: number;
  alignmentTimeoutCount: number;
  duplicateObservationCount: number;
  transmitterSequenceGapCount: number;
  channelMismatchCount: number;
  receiverBootTransitionCount: number;
  stalePacketEvictionCount: number;
}

interface PendingPacket {
  transmitterId: string;
  transmitterBootId: string;
  transmitterPacketSeq: number;
  channel: number;
  bandwidthMhz: number;
  observations: Record<ReceiverSlot, ReceiverObservation | null>;
  firstReceivedAtMs: number;
}

const emptyObservations = (): Record<ReceiverSlot, ReceiverObservation | null> => ({
  A: null,
  B: null,
  C: null,
  D: null,
});

const emptyCounts = (): Record<ReceiverSlot, number> => ({ A: 0, B: 0, C: 0, D: 0 });

export class JointPacketAligner {
  private readonly pending = new Map<string, PendingPacket>();
  private readonly receiverBoots = new Map<ReceiverSlot, string>();
  private readonly lastSequence = new Map<string, number>();
  private readonly finalized: AlignedPacket[] = [];
  private readonly metricsState: AlignmentMetrics = {
    packetsReceivedByReceiver: emptyCounts(),
    alignedPacketCount: 0,
    fourOfFourCount: 0,
    threeOfFourCount: 0,
    twoOrFewerCount: 0,
    alignmentTimeoutCount: 0,
    duplicateObservationCount: 0,
    transmitterSequenceGapCount: 0,
    channelMismatchCount: 0,
    receiverBootTransitionCount: 0,
    stalePacketEvictionCount: 0,
  };

  constructor(private readonly timeoutMs = 75, private readonly maxPending = 4096) {
    if (timeoutMs <= 0 || maxPending <= 0) throw new Error("invalid aligner limits");
  }

  add(observation: ReceiverObservation): AlignedPacket[] {
    this.expire(observation.receivedAtMs);
    this.metricsState.packetsReceivedByReceiver[observation.receiverSlot] += 1;

    const previousBoot = this.receiverBoots.get(observation.receiverSlot);
    if (previousBoot !== undefined && previousBoot !== observation.receiverBootId) {
      this.metricsState.receiverBootTransitionCount += 1;
      this.dropPacketsContaining(observation.receiverSlot);
    }
    this.receiverBoots.set(observation.receiverSlot, observation.receiverBootId);

    const streamKey = `${observation.transmitterId}:${observation.transmitterBootId}`;
    const previousSequence = this.lastSequence.get(streamKey);
    if (previousSequence !== undefined) {
      const delta = (observation.transmitterPacketSeq - previousSequence) >>> 0;
      if (delta > 1 && delta < 0x80000000) this.metricsState.transmitterSequenceGapCount += delta - 1;
    }
    if (previousSequence === undefined || this.isNewer(observation.transmitterPacketSeq, previousSequence)) {
      this.lastSequence.set(streamKey, observation.transmitterPacketSeq);
    }

    const key = `${streamKey}:${observation.transmitterPacketSeq >>> 0}`;
    let packet = this.pending.get(key);
    if (!packet) {
      packet = {
        transmitterId: observation.transmitterId,
        transmitterBootId: observation.transmitterBootId,
        transmitterPacketSeq: observation.transmitterPacketSeq >>> 0,
        channel: observation.channel,
        bandwidthMhz: observation.bandwidthMhz,
        observations: emptyObservations(),
        firstReceivedAtMs: observation.receivedAtMs,
      };
      this.pending.set(key, packet);
    }

    if (packet.channel !== observation.channel || packet.bandwidthMhz !== observation.bandwidthMhz) {
      this.metricsState.channelMismatchCount += 1;
      return this.drainFinalized();
    }
    if (packet.observations[observation.receiverSlot]) {
      this.metricsState.duplicateObservationCount += 1;
      return this.drainFinalized();
    }

    packet.observations[observation.receiverSlot] = observation;
    if (this.count(packet.observations) === 4) {
      this.pending.delete(key);
      this.finalize(packet, observation.receivedAtMs, false);
    }
    this.enforceBound(observation.receivedAtMs);
    return this.drainFinalized();
  }

  expire(nowMs: number): AlignedPacket[] {
    for (const [key, packet] of this.pending) {
      if (nowMs - packet.firstReceivedAtMs >= this.timeoutMs) {
        this.pending.delete(key);
        this.finalize(packet, nowMs, true);
      }
    }
    return this.drainFinalized();
  }

  metrics(): AlignmentMetrics {
    return structuredClone(this.metricsState);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private finalize(packet: PendingPacket, finalizedAtMs: number, timedOut: boolean): void {
    const receiverCount = this.count(packet.observations);
    this.metricsState.alignedPacketCount += 1;
    if (receiverCount === 4) this.metricsState.fourOfFourCount += 1;
    else if (receiverCount === 3) this.metricsState.threeOfFourCount += 1;
    else this.metricsState.twoOrFewerCount += 1;
    if (timedOut) this.metricsState.alignmentTimeoutCount += 1;
    this.finalized.push({
      transmitterId: packet.transmitterId,
      transmitterBootId: packet.transmitterBootId,
      transmitterPacketSeq: packet.transmitterPacketSeq,
      observations: packet.observations,
      receiverCount,
      complete: receiverCount === 4,
      firstReceivedAtMs: packet.firstReceivedAtMs,
      finalizedAtMs,
    });
  }

  private dropPacketsContaining(slot: ReceiverSlot): void {
    for (const [key, packet] of this.pending) {
      if (packet.observations[slot]) {
        this.pending.delete(key);
        this.metricsState.stalePacketEvictionCount += 1;
      }
    }
  }

  private enforceBound(nowMs: number): void {
    while (this.pending.size > this.maxPending) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].firstReceivedAtMs - b[1].firstReceivedAtMs)[0];
      if (!oldest) return;
      this.pending.delete(oldest[0]);
      this.metricsState.stalePacketEvictionCount += 1;
      this.finalize(oldest[1], nowMs, true);
    }
  }

  private drainFinalized(): AlignedPacket[] {
    return this.finalized.splice(0, this.finalized.length);
  }

  private count(observations: Record<ReceiverSlot, ReceiverObservation | null>): number {
    return Object.values(observations).filter(Boolean).length;
  }

  private isNewer(current: number, previous: number): boolean {
    const delta = (current - previous) >>> 0;
    return delta !== 0 && delta < 0x80000000;
  }
}
