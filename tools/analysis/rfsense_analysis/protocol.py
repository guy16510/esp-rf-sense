"""Parser for the binary CSI protocol v1, matching firmware/components/protocol/Protocol.cpp and
the TypeScript collector decoder. Reads the collector's authoritative recordings.

The collector writes two coordinated files per recording:
  <name>.csi.bin  -- repeated [u32 LE length][datagram bytes]; the unaltered source of truth
  <name>.jsonl    -- one decoded datagram per line (CSI as base64); convenient but derived

This module reads the binary file (re-validating magic, version, and CRC32 independently) so a
bug in any single encoder cannot silently corrupt a dataset. Raw CSI bytes are never altered.
"""

from __future__ import annotations

import base64
import json
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

MAGIC = b"RFCS"
PROTOCOL_VERSION = 1
DATAGRAM_HEADER_SIZE = 32
FRAME_FIXED_SIZE = 28
CRC_SIZE = 4
PING_SEQ_NONE = 0xFFFFFFFF
FLAG_MAINTENANCE = 0x01


def _crc32_table() -> np.ndarray:
    table = np.zeros(256, dtype=np.uint32)
    for n in range(256):
        c = np.uint32(n)
        for _ in range(8):
            c = np.uint32((0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1))
        table[n] = c
    return table


_CRC_TABLE = _crc32_table()


def crc32(data: bytes) -> int:
    """IEEE 802.3 CRC32 (reflected, poly 0xEDB88320) -- identical to the firmware implementation."""
    crc = np.uint32(0xFFFFFFFF)
    for byte in data:
        crc = np.uint32(_CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >> 8))
    return int(crc ^ np.uint32(0xFFFFFFFF))


@dataclass(frozen=True)
class DatagramHeader:
    protocol_version: int
    flags: int
    capture_mode: int
    device_id: int
    boot_id: int
    packet_seq: int
    batch_seq: int
    frame_count: int
    payload_len: int


@dataclass(frozen=True)
class Frame:
    frame_seq: int
    timestamp_us: int
    ping_seq: int
    rssi: int
    noise_floor: int
    channel: int
    secondary_channel: int
    bandwidth: int
    phy_mode: int
    rate: int
    first_word_invalid: int
    link_id: int
    csi: bytes  # raw signed I/Q bytes, exactly as the device sent them

    @property
    def ping_correlated(self) -> bool:
        return self.ping_seq != PING_SEQ_NONE


@dataclass
class Datagram:
    header: DatagramHeader
    frames: list[Frame] = field(default_factory=list)


class ProtocolError(ValueError):
    """Raised when a datagram fails magic/version/length/CRC validation."""


def parse_datagram(buf: bytes, *, verify_crc: bool = True) -> Datagram:
    if len(buf) < DATAGRAM_HEADER_SIZE + CRC_SIZE:
        raise ProtocolError("datagram too short")
    if buf[0:4] != MAGIC:
        raise ProtocolError("bad magic")
    version = buf[4]
    if version != PROTOCOL_VERSION:
        raise ProtocolError(f"unsupported protocol version {version}")
    flags = buf[5]
    capture_mode = buf[6]
    device_id, boot_id, packet_seq, batch_seq = struct.unpack_from("<IIII", buf, 8)
    frame_count, payload_len = struct.unpack_from("<HH", buf, 24)
    if DATAGRAM_HEADER_SIZE + payload_len + CRC_SIZE != len(buf):
        raise ProtocolError("payloadLen mismatch")

    body_len = len(buf) - CRC_SIZE
    if verify_crc:
        expected = crc32(buf[:body_len])
        (actual,) = struct.unpack_from("<I", buf, body_len)
        if expected != actual:
            raise ProtocolError("crc mismatch")

    header = DatagramHeader(
        protocol_version=version,
        flags=flags,
        capture_mode=capture_mode,
        device_id=device_id,
        boot_id=boot_id,
        packet_seq=packet_seq,
        batch_seq=batch_seq,
        frame_count=frame_count,
        payload_len=payload_len,
    )

    frames: list[Frame] = []
    off = DATAGRAM_HEADER_SIZE
    for _ in range(frame_count):
        if off + FRAME_FIXED_SIZE > body_len:
            raise ProtocolError("frame header out of bounds")
        frame_seq, timestamp_us, ping_seq = struct.unpack_from("<IQI", buf, off)
        rssi, noise_floor = struct.unpack_from("<bb", buf, off + 16)
        channel = buf[off + 18]
        secondary_channel = buf[off + 19]
        bandwidth = buf[off + 20]
        phy_mode = buf[off + 21]
        rate = buf[off + 22]
        first_word_invalid = buf[off + 23]
        link_id, csi_len = struct.unpack_from("<HH", buf, off + 24)
        csi_start = off + FRAME_FIXED_SIZE
        if csi_start + csi_len > body_len:
            raise ProtocolError("csi out of bounds")
        frames.append(
            Frame(
                frame_seq=frame_seq,
                timestamp_us=timestamp_us,
                ping_seq=ping_seq,
                rssi=rssi,
                noise_floor=noise_floor,
                channel=channel,
                secondary_channel=secondary_channel,
                bandwidth=bandwidth,
                phy_mode=phy_mode,
                rate=rate,
                first_word_invalid=first_word_invalid,
                link_id=link_id,
                csi=bytes(buf[csi_start : csi_start + csi_len]),
            )
        )
        off = csi_start + csi_len
    return Datagram(header=header, frames=frames)


def read_bin(path: str | Path, *, verify_crc: bool = True) -> Iterator[Datagram]:
    """Streams datagrams from a collector .csi.bin recording (length-prefixed)."""
    data = Path(path).read_bytes()
    pos = 0
    n = len(data)
    while pos + 4 <= n:
        (length,) = struct.unpack_from("<I", data, pos)
        pos += 4
        if pos + length > n:
            raise ProtocolError("truncated recording: length prefix exceeds file")
        yield parse_datagram(data[pos : pos + length], verify_crc=verify_crc)
        pos += length


def read_jsonl(path: str | Path) -> Iterator[Datagram]:
    """Streams datagrams from a collector .jsonl recording (CSI is base64-decoded back to bytes)."""
    with Path(path).open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            header = DatagramHeader(
                protocol_version=PROTOCOL_VERSION,
                flags=obj["flags"],
                capture_mode=obj["captureMode"],
                device_id=obj["deviceId"],
                boot_id=obj["bootId"],
                packet_seq=obj["packetSeq"],
                batch_seq=obj["batchSeq"],
                frame_count=len(obj["frames"]),
                payload_len=0,
            )
            frames = [
                Frame(
                    frame_seq=f["frameSeq"],
                    timestamp_us=f["timestampUs"],
                    ping_seq=f["pingSeq"],
                    rssi=f["rssi"],
                    noise_floor=f["noiseFloor"],
                    channel=f["channel"],
                    secondary_channel=f["secondaryChannel"],
                    bandwidth=f["bandwidth"],
                    phy_mode=f["phyMode"],
                    rate=f["rate"],
                    first_word_invalid=f["firstWordInvalid"],
                    link_id=f["linkId"],
                    csi=base64.b64decode(f["csiBase64"]),
                )
                for f in obj["frames"]
            ]
            yield Datagram(header=header, frames=frames)


def iter_frames(datagrams: Iterator[Datagram]) -> Iterator[Frame]:
    for dg in datagrams:
        yield from dg.frames
