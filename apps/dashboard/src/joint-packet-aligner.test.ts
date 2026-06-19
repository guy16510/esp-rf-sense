import { describe, expect, it } from "vitest";
import { JointPacketAligner, type ReceiverObservation, type ReceiverSlot } from "./joint-packet-aligner.js";

function observation(slot: ReceiverSlot, seq: number, at: number, overrides: Partial<ReceiverObservation> = {}): ReceiverObservation {
  return {
    receiverSlot: slot,
    receiverDeviceId: `rx-${slot}`,
    receiverBootId: `boot-${slot}`,
    receiverFrameSeq: seq,
    receiverTimestampUs: at * 1000,
    transmitterId: "tx-1",
    transmitterBootId: "tx-boot-1",
    transmitterPacketSeq: seq,
    rssi: -50,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csi: new Uint8Array([1, 2, 3]),
    receivedAtMs: at,
    ...overrides,
  };
}

describe("JointPacketAligner", () => {
  it("aligns four receivers observing the same transmitter sequence", () => {
    const aligner = new JointPacketAligner(50);
    const output = [
      ...aligner.add(observation("C", 7, 1)),
      ...aligner.add(observation("A", 7, 2)),
      ...aligner.add(observation("D", 7, 3)),
      ...aligner.add(observation("B", 7, 4)),
    ];
    expect(output).toHaveLength(1);
    expect(output[0]?.receiverCount).toBe(4);
    expect(output[0]?.complete).toBe(true);
    expect(output[0]?.transmitterPacketSeq).toBe(7);
  });

  it("finalizes three-of-four after timeout", () => {
    const aligner = new JointPacketAligner(10);
    aligner.add(observation("A", 2, 0));
    aligner.add(observation("B", 2, 1));
    aligner.add(observation("C", 2, 2));
    const output = aligner.expire(10);
    expect(output).toHaveLength(1);
    expect(output[0]?.receiverCount).toBe(3);
    expect(output[0]?.complete).toBe(false);
    expect(aligner.metrics().threeOfFourCount).toBe(1);
  });

  it("ignores duplicate receiver observations", () => {
    const aligner = new JointPacketAligner(10);
    aligner.add(observation("A", 3, 0));
    aligner.add(observation("A", 3, 1));
    expect(aligner.metrics().duplicateObservationCount).toBe(1);
    expect(aligner.pendingCount()).toBe(1);
  });

  it("rejects channel mismatches without increasing receiver count", () => {
    const aligner = new JointPacketAligner(10);
    aligner.add(observation("A", 4, 0));
    aligner.add(observation("B", 4, 1, { channel: 11 }));
    const output = aligner.expire(10);
    expect(output[0]?.receiverCount).toBe(1);
    expect(aligner.metrics().channelMismatchCount).toBe(1);
  });

  it("evicts active packets contaminated by a receiver reboot", () => {
    const aligner = new JointPacketAligner(10);
    aligner.add(observation("A", 5, 0));
    aligner.add(observation("B", 5, 1));
    aligner.add(observation("A", 6, 2, { receiverBootId: "boot-A-2" }));
    expect(aligner.metrics().receiverBootTransitionCount).toBe(1);
    expect(aligner.metrics().stalePacketEvictionCount).toBe(1);
  });

  it("handles uint32 transmitter sequence wraparound", () => {
    const aligner = new JointPacketAligner(10);
    aligner.add(observation("A", 0xffffffff, 0));
    aligner.add(observation("A", 0, 1));
    expect(aligner.metrics().transmitterSequenceGapCount).toBe(0);
  });

  it("produces deterministic output under randomized arrival order", () => {
    const orders: ReceiverSlot[][] = [["A", "B", "C", "D"], ["D", "B", "A", "C"], ["C", "A", "D", "B"]];
    const snapshots = orders.map((order) => {
      const aligner = new JointPacketAligner(10);
      const output = order.flatMap((slot, index) => aligner.add(observation(slot, 9, index)));
      return output.map((packet) => ({ seq: packet.transmitterPacketSeq, slots: Object.keys(packet.observations).filter((slot) => packet.observations[slot as ReceiverSlot]) }));
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });
});
