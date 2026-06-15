import { describe, expect, it } from 'vitest';

import {
  CRC_SIZE,
  DATAGRAM_HEADER_SIZE,
  FRAME_FIXED_SIZE,
  MAGIC,
  PROTOCOL_VERSION,
  crc32,
  parseDatagram,
  type FrameRecord,
} from './protocol.js';

// Builds a datagram exactly the way firmware/components/protocol/Protocol.cpp does, so the parser
// is tested against the real wire layout rather than against itself.
function buildDatagram(
  header: {
    flags?: number;
    captureMode?: number;
    deviceId: number;
    bootId: number;
    packetSeq: number;
    batchSeq: number;
  },
  frames: Array<Partial<FrameRecord> & { csi: Buffer }>,
): Buffer {
  let payloadLen = 0;
  for (const f of frames) payloadLen += FRAME_FIXED_SIZE + f.csi.length;
  const buf = Buffer.alloc(DATAGRAM_HEADER_SIZE + payloadLen + CRC_SIZE);
  buf[0] = MAGIC[0]!;
  buf[1] = MAGIC[1]!;
  buf[2] = MAGIC[2]!;
  buf[3] = MAGIC[3]!;
  buf[4] = PROTOCOL_VERSION;
  buf[5] = header.flags ?? 0;
  buf[6] = header.captureMode ?? 0;
  buf[7] = 0;
  buf.writeUInt32LE(header.deviceId >>> 0, 8);
  buf.writeUInt32LE(header.bootId >>> 0, 12);
  buf.writeUInt32LE(header.packetSeq >>> 0, 16);
  buf.writeUInt32LE(header.batchSeq >>> 0, 20);
  buf.writeUInt16LE(frames.length, 24);
  buf.writeUInt16LE(payloadLen, 26);
  buf.writeUInt32LE(0, 28);

  let off = DATAGRAM_HEADER_SIZE;
  for (const f of frames) {
    buf.writeUInt32LE((f.frameSeq ?? 0) >>> 0, off);
    buf.writeBigUInt64LE(BigInt(f.timestampUs ?? 0), off + 4);
    buf.writeUInt32LE((f.pingSeq ?? 0xffffffff) >>> 0, off + 12);
    buf.writeInt8(f.rssi ?? 0, off + 16);
    buf.writeInt8(f.noiseFloor ?? 0, off + 17);
    buf[off + 18] = f.channel ?? 0;
    buf[off + 19] = f.secondaryChannel ?? 0;
    buf[off + 20] = f.bandwidth ?? 0;
    buf[off + 21] = f.phyMode ?? 0;
    buf[off + 22] = f.rate ?? 0;
    buf[off + 23] = f.firstWordInvalid ?? 0;
    buf.writeUInt16LE(f.linkId ?? 0, off + 24);
    buf.writeUInt16LE(f.csi.length, off + 26);
    f.csi.copy(buf, off + FRAME_FIXED_SIZE);
    off += FRAME_FIXED_SIZE + f.csi.length;
  }
  buf.writeUInt32LE(crc32(buf, 0, off), off);
  return buf;
}

describe('crc32', () => {
  it('matches the canonical IEEE check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('parseDatagram', () => {
  it('round-trips a two-frame datagram with raw CSI preserved', () => {
    const csiA = Buffer.from([1, 2, 3, 4, 0xff, 0x80]);
    const csiB = Buffer.from([9, 8, 7]);
    const buf = buildDatagram(
      { deviceId: 0xa1b2c3d4, bootId: 7, packetSeq: 42, batchSeq: 3, captureMode: 1 },
      [
        {
          frameSeq: 100,
          timestampUs: 123456789,
          pingSeq: 5,
          rssi: -40,
          noiseFloor: -95,
          channel: 6,
          csi: csiA,
        },
        { frameSeq: 101, timestampUs: 123457000, rssi: -41, linkId: 2, csi: csiB },
      ],
    );
    const res = parseDatagram(buf);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.datagram.header.deviceId >>> 0).toBe(0xa1b2c3d4);
    expect(res.datagram.header.bootId).toBe(7);
    expect(res.datagram.header.packetSeq).toBe(42);
    expect(res.datagram.header.captureMode).toBe(1);
    expect(res.datagram.frames).toHaveLength(2);
    const [f0, f1] = res.datagram.frames;
    expect(f0!.frameSeq).toBe(100);
    expect(f0!.pingSeq).toBe(5);
    expect(f0!.rssi).toBe(-40);
    expect(f0!.noiseFloor).toBe(-95);
    expect(f0!.csi.equals(csiA)).toBe(true);
    expect(f1!.frameSeq).toBe(101);
    expect(f1!.pingSeq).toBe(0xffffffff);
    expect(f1!.csi.equals(csiB)).toBe(true);
  });

  it('detects a single-bit corruption via CRC', () => {
    const buf = buildDatagram({ deviceId: 1, bootId: 1, packetSeq: 1, batchSeq: 0 }, [
      { frameSeq: 1, csi: Buffer.from([1, 2, 3, 4]) },
    ]);
    const corruptOffset = DATAGRAM_HEADER_SIZE + 2;
    buf[corruptOffset] = buf[corruptOffset]! ^ 0x01; // flip a CSI bit
    const res = parseDatagram(buf);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('crc mismatch');
  });

  it('rejects bad magic, short buffers, and bad version', () => {
    expect(parseDatagram(Buffer.alloc(10))).toMatchObject({ ok: false });
    const good = buildDatagram({ deviceId: 1, bootId: 1, packetSeq: 1, batchSeq: 0 }, [
      { csi: Buffer.alloc(0) },
    ]);
    const badMagic = Buffer.from(good);
    badMagic[0] = 0;
    expect(parseDatagram(badMagic)).toMatchObject({ ok: false, error: 'bad magic' });
    const badVer = Buffer.from(good);
    badVer[4] = 99;
    expect(parseDatagram(badVer).ok).toBe(false);
  });

  it('rejects a payloadLen that does not match the buffer', () => {
    const buf = buildDatagram({ deviceId: 1, bootId: 1, packetSeq: 1, batchSeq: 0 }, [
      { csi: Buffer.from([1, 2]) },
    ]);
    buf.writeUInt16LE(999, 26); // lie about payloadLen
    expect(parseDatagram(buf)).toMatchObject({ ok: false, error: 'payloadLen mismatch' });
  });
});
