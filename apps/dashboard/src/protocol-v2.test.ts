import { describe, expect, it } from "vitest";
import { decodeCsiFrameV2, encodeCsiFrameV2 } from "./protocol-v2.js";

describe("protocol v2", () => {
  const frame = {
    receiverFrameSeq: 42,
    receiverTimestampUs: 123456789n,
    transmitterId: 7,
    transmitterBootId: 11,
    transmitterPacketSeq: 99,
    rssi: -61,
    noiseFloor: -96,
    channel: 6,
    bandwidthMhz: 20,
    firstWordInvalid: false,
    csi: Buffer.from([1, 2, 3, 4]),
  };

  it("round trips all transmitter identity fields", () => {
    expect(decodeCsiFrameV2(encodeCsiFrameV2(frame))).toEqual(frame);
  });

  it("rejects CRC corruption", () => {
    const encoded = encodeCsiFrameV2(frame);
    encoded[10] ^= 0xff;
    expect(() => decodeCsiFrameV2(encoded)).toThrow(/CRC/);
  });

  it("rejects truncation", () => {
    const encoded = encodeCsiFrameV2(frame);
    expect(() => decodeCsiFrameV2(encoded.subarray(0, encoded.length - 1))).toThrow(/length|truncated/);
  });

  it("preserves uint32 sequence wrap values", () => {
    const encoded = encodeCsiFrameV2({ ...frame, transmitterPacketSeq: 0xffffffff });
    expect(decodeCsiFrameV2(encoded).transmitterPacketSeq).toBe(0xffffffff);
  });
});
