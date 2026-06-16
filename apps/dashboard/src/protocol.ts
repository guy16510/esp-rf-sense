const MAGIC = Uint8Array.from([0x52, 0x46, 0x43, 0x53]);
const PROTOCOL_VERSION = 1;
const DATAGRAM_HEADER_SIZE = 32;
const FRAME_FIXED_SIZE = 28;
const CRC_SIZE = 4;

export interface DatagramHeader {
  flags: number;
  deviceId: number;
  bootId: number;
  packetSeq: number;
  frameCount: number;
}

export interface CsiFrame {
  frameSeq: number;
  timestampUs: number;
  rssi: number;
  firstWordInvalid: number;
  csi: Buffer;
}

export interface CsiDatagram {
  header: DatagramHeader;
  frames: CsiFrame[];
}

export type ParseResult = { ok: true; datagram: CsiDatagram } | { ok: false; error: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array, end: number): number {
  let crc = 0xffffffff;
  for (let index = 0; index < end; index++) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseDatagram(buffer: Buffer): ParseResult {
  if (buffer.length < DATAGRAM_HEADER_SIZE + CRC_SIZE) {
    return { ok: false, error: 'datagram too short' };
  }
  if (
    buffer[0] !== MAGIC[0] ||
    buffer[1] !== MAGIC[1] ||
    buffer[2] !== MAGIC[2] ||
    buffer[3] !== MAGIC[3]
  ) {
    return { ok: false, error: 'bad magic' };
  }
  if (buffer[4] !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${buffer[4]}` };
  }

  const payloadLength = buffer.readUInt16LE(26);
  const bodyLength = buffer.length - CRC_SIZE;
  if (DATAGRAM_HEADER_SIZE + payloadLength + CRC_SIZE !== buffer.length) {
    return { ok: false, error: 'payload length mismatch' };
  }
  if (crc32(buffer, bodyLength) !== buffer.readUInt32LE(bodyLength)) {
    return { ok: false, error: 'crc mismatch' };
  }

  const header: DatagramHeader = {
    flags: buffer[5]!,
    deviceId: buffer.readUInt32LE(8),
    bootId: buffer.readUInt32LE(12),
    packetSeq: buffer.readUInt32LE(16),
    frameCount: buffer.readUInt16LE(24),
  };
  const frames: CsiFrame[] = [];
  let offset = DATAGRAM_HEADER_SIZE;
  for (let index = 0; index < header.frameCount; index++) {
    if (offset + FRAME_FIXED_SIZE > bodyLength) {
      return { ok: false, error: 'frame header out of bounds' };
    }
    const csiLength = buffer.readUInt16LE(offset + 26);
    const csiStart = offset + FRAME_FIXED_SIZE;
    if (csiStart + csiLength > bodyLength) {
      return { ok: false, error: 'csi out of bounds' };
    }
    frames.push({
      frameSeq: buffer.readUInt32LE(offset),
      timestampUs: Number(buffer.readBigUInt64LE(offset + 4)),
      rssi: buffer.readInt8(offset + 16),
      firstWordInvalid: buffer[offset + 23]!,
      csi: Buffer.from(buffer.subarray(csiStart, csiStart + csiLength)),
    });
    offset = csiStart + csiLength;
  }
  if (offset !== bodyLength) {
    return { ok: false, error: 'trailing bytes after frames' };
  }
  return { ok: true, datagram: { header, frames } };
}
