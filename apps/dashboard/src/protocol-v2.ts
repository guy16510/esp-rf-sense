const MAGIC = Buffer.from("RFV2");
export const PROTOCOL_V2 = 2;
export const CSI_FRAME_V2_FIXED_BYTES = 39;

export interface CsiFrameV2 {
  receiverFrameSeq: number;
  receiverTimestampUs: bigint;
  transmitterId: number;
  transmitterBootId: number;
  transmitterPacketSeq: number;
  rssi: number;
  noiseFloor?: number;
  channel: number;
  bandwidthMhz: number;
  firstWordInvalid: boolean;
  csi: Buffer;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeCsiFrameV2(frame: CsiFrameV2): Buffer {
  if (frame.csi.length > 0xffff) throw new Error("CSI payload exceeds uint16 length");
  const output = Buffer.alloc(CSI_FRAME_V2_FIXED_BYTES + frame.csi.length + 4);
  MAGIC.copy(output, 0);
  output.writeUInt8(PROTOCOL_V2, 4);
  output.writeUInt32LE(frame.receiverFrameSeq >>> 0, 5);
  output.writeBigUInt64LE(frame.receiverTimestampUs, 9);
  output.writeUInt32LE(frame.transmitterId >>> 0, 17);
  output.writeUInt32LE(frame.transmitterBootId >>> 0, 21);
  output.writeUInt32LE(frame.transmitterPacketSeq >>> 0, 25);
  output.writeInt8(frame.rssi, 29);
  output.writeInt8(frame.noiseFloor ?? 0, 30);
  output.writeUInt8(frame.channel, 31);
  output.writeUInt8(frame.bandwidthMhz, 32);
  output.writeUInt8(frame.firstWordInvalid ? 1 : 0, 33);
  output.writeUInt16LE(frame.csi.length, 34);
  output.writeUIntBE(0, 36, 3);
  frame.csi.copy(output, CSI_FRAME_V2_FIXED_BYTES);
  output.writeUInt32LE(crc32(output.subarray(0, output.length - 4)), output.length - 4);
  return output;
}

export function decodeCsiFrameV2(input: Buffer): CsiFrameV2 {
  if (input.length < CSI_FRAME_V2_FIXED_BYTES + 4) throw new Error("truncated protocol v2 frame");
  if (!input.subarray(0, 4).equals(MAGIC)) throw new Error("bad protocol v2 magic");
  if (input.readUInt8(4) !== PROTOCOL_V2) throw new Error("unsupported protocol version");
  const csiLength = input.readUInt16LE(34);
  if (input.length !== CSI_FRAME_V2_FIXED_BYTES + csiLength + 4) throw new Error("protocol v2 length mismatch");
  const expected = input.readUInt32LE(input.length - 4);
  const actual = crc32(input.subarray(0, input.length - 4));
  if (expected !== actual) throw new Error("protocol v2 CRC mismatch");
  return {
    receiverFrameSeq: input.readUInt32LE(5),
    receiverTimestampUs: input.readBigUInt64LE(9),
    transmitterId: input.readUInt32LE(17),
    transmitterBootId: input.readUInt32LE(21),
    transmitterPacketSeq: input.readUInt32LE(25),
    rssi: input.readInt8(29),
    noiseFloor: input.readInt8(30),
    channel: input.readUInt8(31),
    bandwidthMhz: input.readUInt8(32),
    firstWordInvalid: input.readUInt8(33) !== 0,
    csi: Buffer.from(input.subarray(CSI_FRAME_V2_FIXED_BYTES, CSI_FRAME_V2_FIXED_BYTES + csiLength)),
  };
}
