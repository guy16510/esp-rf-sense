// Binary CSI streaming protocol v1 decoder.
//
// This mirrors firmware/components/protocol/Protocol.cpp byte-for-byte. Any change to the wire
// format must be made in both places and in docs/csi-protocol.md. Raw CSI bytes are never
// altered here -- they are surfaced exactly as the device sent them.

export const MAGIC = Uint8Array.from([0x52, 0x46, 0x43, 0x53]); // "RFCS"
export const PROTOCOL_VERSION = 1;
export const DATAGRAM_HEADER_SIZE = 32;
export const FRAME_FIXED_SIZE = 28;
export const CRC_SIZE = 4;
export const MAX_DATAGRAM_SIZE = 1400;
export const PING_SEQ_NONE = 0xffffffff;
export const FLAG_MAINTENANCE = 0x01;

export enum CaptureMode {
  Controlled = 0,
  Normal = 1,
  Passive = 2,
}

export interface DatagramHeader {
  protocolVersion: number;
  flags: number;
  captureMode: number;
  deviceId: number;
  bootId: number;
  packetSeq: number;
  batchSeq: number;
  frameCount: number;
  payloadLen: number;
}

export interface FrameRecord {
  frameSeq: number;
  timestampUs: number; // microseconds since device boot (fits in a double for centuries)
  pingSeq: number; // PING_SEQ_NONE when the frame is not ping-correlated
  rssi: number;
  noiseFloor: number;
  channel: number;
  secondaryChannel: number;
  bandwidth: number;
  phyMode: number;
  rate: number;
  firstWordInvalid: number;
  linkId: number;
  csiLen: number;
  csi: Buffer; // raw signed I/Q bytes, copied out verbatim
}

export interface Datagram {
  header: DatagramHeader;
  frames: FrameRecord[];
}

export type ParseResult = { ok: true; datagram: Datagram } | { ok: false; error: string };

// IEEE 802.3 CRC32 (reflected, poly 0xEDB88320) -- the same polynomial the firmware uses.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseDatagram(buf: Buffer): ParseResult {
  if (buf.length < DATAGRAM_HEADER_SIZE + CRC_SIZE) {
    return { ok: false, error: 'datagram too short' };
  }
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3]) {
    return { ok: false, error: 'bad magic' };
  }
  const protocolVersion = buf[4]!;
  if (protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${protocolVersion}` };
  }
  const header: DatagramHeader = {
    protocolVersion,
    flags: buf[5]!,
    captureMode: buf[6]!,
    deviceId: buf.readUInt32LE(8),
    bootId: buf.readUInt32LE(12),
    packetSeq: buf.readUInt32LE(16),
    batchSeq: buf.readUInt32LE(20),
    frameCount: buf.readUInt16LE(24),
    payloadLen: buf.readUInt16LE(26),
  };
  if (DATAGRAM_HEADER_SIZE + header.payloadLen + CRC_SIZE !== buf.length) {
    return { ok: false, error: 'payloadLen mismatch' };
  }

  const bodyLen = buf.length - CRC_SIZE;
  const expected = crc32(buf, 0, bodyLen);
  const actual = buf.readUInt32LE(bodyLen);
  if (expected !== actual) {
    return { ok: false, error: 'crc mismatch' };
  }

  const frames: FrameRecord[] = [];
  let offset = DATAGRAM_HEADER_SIZE;
  for (let i = 0; i < header.frameCount; i++) {
    if (offset + FRAME_FIXED_SIZE > bodyLen) {
      return { ok: false, error: 'frame header out of bounds' };
    }
    const csiLen = buf.readUInt16LE(offset + 26);
    const csiStart = offset + FRAME_FIXED_SIZE;
    if (csiStart + csiLen > bodyLen) {
      return { ok: false, error: 'csi out of bounds' };
    }
    frames.push({
      frameSeq: buf.readUInt32LE(offset),
      timestampUs: Number(buf.readBigUInt64LE(offset + 4)),
      pingSeq: buf.readUInt32LE(offset + 12),
      rssi: buf.readInt8(offset + 16),
      noiseFloor: buf.readInt8(offset + 17),
      channel: buf[offset + 18]!,
      secondaryChannel: buf[offset + 19]!,
      bandwidth: buf[offset + 20]!,
      phyMode: buf[offset + 21]!,
      rate: buf[offset + 22]!,
      firstWordInvalid: buf[offset + 23]!,
      linkId: buf.readUInt16LE(offset + 24),
      csiLen,
      csi: Buffer.from(buf.subarray(csiStart, csiStart + csiLen)),
    });
    offset = csiStart + csiLen;
  }
  if (offset !== bodyLen) {
    return { ok: false, error: 'trailing bytes after frames' };
  }
  return { ok: true, datagram: { header, frames } };
}
