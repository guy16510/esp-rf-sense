import struct

import pytest

from rfsense_analysis import protocol as proto


def build_datagram(header, frames):
    """Build a datagram exactly like firmware/components/protocol/Protocol.cpp for round-trip tests."""
    payload = bytearray()
    for f in frames:
        csi = f["csi"]
        payload += struct.pack(
            "<IQIbbBBBBBBHH",
            f.get("frame_seq", 0),
            f.get("timestamp_us", 0),
            f.get("ping_seq", proto.PING_SEQ_NONE),
            f.get("rssi", 0),
            f.get("noise_floor", 0),
            f.get("channel", 0),
            f.get("secondary_channel", 0),
            f.get("bandwidth", 0),
            f.get("phy_mode", 0),
            f.get("rate", 0),
            f.get("first_word_invalid", 0),
            f.get("link_id", 0),
            len(csi),
        )
        payload += csi
    buf = bytearray()
    buf += proto.MAGIC
    buf += bytes([proto.PROTOCOL_VERSION, header.get("flags", 0), header.get("capture_mode", 0), 0])
    buf += struct.pack(
        "<IIII",
        header["device_id"],
        header["boot_id"],
        header["packet_seq"],
        header["batch_seq"],
    )
    buf += struct.pack("<HH", len(frames), len(payload))
    buf += struct.pack("<I", 0)  # reserved1
    buf += payload
    buf += struct.pack("<I", proto.crc32(bytes(buf)))
    return bytes(buf)


def test_crc32_canonical_vector():
    assert proto.crc32(b"123456789") == 0xCBF43926


def test_round_trip_two_frames():
    csi_a = bytes([1, 2, 3, 4, 0xFF, 0x80])
    csi_b = bytes([9, 8, 7])
    buf = build_datagram(
        {
            "device_id": 0xA1B2C3D4,
            "boot_id": 7,
            "packet_seq": 42,
            "batch_seq": 3,
            "capture_mode": 1,
        },
        [
            {"frame_seq": 100, "timestamp_us": 123456789, "ping_seq": 5, "rssi": -40, "csi": csi_a},
            {"frame_seq": 101, "timestamp_us": 123457000, "rssi": -41, "link_id": 2, "csi": csi_b},
        ],
    )
    dg = proto.parse_datagram(buf)
    assert dg.header.device_id == 0xA1B2C3D4
    assert dg.header.packet_seq == 42
    assert dg.header.capture_mode == 1
    assert len(dg.frames) == 2
    assert dg.frames[0].frame_seq == 100
    assert dg.frames[0].ping_seq == 5
    assert dg.frames[0].rssi == -40
    assert dg.frames[0].csi == csi_a
    assert dg.frames[1].ping_correlated is False
    assert dg.frames[1].csi == csi_b


def test_crc_mismatch_detected():
    buf = bytearray(
        build_datagram(
            {"device_id": 1, "boot_id": 1, "packet_seq": 1, "batch_seq": 0},
            [{"frame_seq": 1, "csi": bytes([1, 2, 3, 4])}],
        )
    )
    buf[proto.DATAGRAM_HEADER_SIZE + 2] ^= 0x01
    with pytest.raises(proto.ProtocolError, match="crc"):
        proto.parse_datagram(bytes(buf))


def test_bad_magic_and_version():
    good = build_datagram(
        {"device_id": 1, "boot_id": 1, "packet_seq": 1, "batch_seq": 0},
        [{"csi": b""}],
    )
    bad_magic = bytearray(good)
    bad_magic[0] = 0
    with pytest.raises(proto.ProtocolError, match="magic"):
        proto.parse_datagram(bytes(bad_magic))


def test_read_bin_roundtrip(tmp_path):
    frames = [{"frame_seq": i, "csi": bytes([i, i + 1])} for i in range(3)]
    dg_bytes = build_datagram(
        {"device_id": 9, "boot_id": 2, "packet_seq": 0, "batch_seq": 0}, frames
    )
    path = tmp_path / "rec.csi.bin"
    with path.open("wb") as fh:
        for _ in range(4):
            fh.write(struct.pack("<I", len(dg_bytes)))
            fh.write(dg_bytes)
    parsed = list(proto.read_bin(path))
    assert len(parsed) == 4
    assert all(len(d.frames) == 3 for d in parsed)
