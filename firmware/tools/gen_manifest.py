#!/usr/bin/env python3
"""Generate an OTA manifest JSON for a built application image.

The manifest is what the device downloads and validates *before* fetching firmware. Its fields
mirror firmware/components/ota_manager/include/OtaManifest.h and the validation in
OtaManifest.cpp; keep the two in sync. appSizeBytes and sha256 are computed from the image so
they cannot drift from the bytes actually served.

Usage:
    python firmware/tools/gen_manifest.py \\
        --app build/rf-sense.bin --version 0.2.0 --channel stable \\
        --firmware-url https://ota.local:8443/firmware/0.2.0/rf-sense.bin \\
        --out dist/manifest/stable.json
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys

SCHEMA_VERSION = 1
PROJECT = "rf-sense"
DEFAULT_TARGET = "esp32s3"
DEFAULT_BOARD = "esp32-s3-wroom-1-n4r8"
DEFAULT_FLASH_SIZE = 4 * 1024 * 1024


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="path to the built application .bin")
    parser.add_argument("--version", required=True, help="semantic version, e.g. 0.2.0")
    parser.add_argument("--channel", default="stable", choices=["stable", "development"])
    parser.add_argument("--firmware-url", required=True, help="https URL the device fetches")
    parser.add_argument("--build-id", default="", help="CI build id / git describe")
    parser.add_argument("--target", default=DEFAULT_TARGET)
    parser.add_argument("--board", default=DEFAULT_BOARD)
    parser.add_argument("--flash-size", type=lambda v: int(v, 0), default=DEFAULT_FLASH_SIZE)
    parser.add_argument("--minimum-current-version", default="",
                        help="refuse to apply if the running version is below this")
    parser.add_argument("--mandatory", action="store_true")
    parser.add_argument("--release-notes", default="")
    parser.add_argument("--released-at", default="",
                        help="ISO-8601 timestamp; defaults to now (UTC)")
    parser.add_argument("--out", default="-", help="output path, or - for stdout")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.app):
        print(f"error: app image not found: {args.app}", file=sys.stderr)
        return 2

    released_at = args.released_at or datetime.datetime.now(
        datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "project": PROJECT,
        "channel": args.channel,
        "version": args.version,
        "buildId": args.build_id,
        "target": args.target,
        "board": args.board,
        "flashSizeBytes": args.flash_size,
        "appSizeBytes": os.path.getsize(args.app),
        "sha256": sha256_of(args.app),
        "firmwareUrl": args.firmware_url,
        "releasedAt": released_at,
        "minimumCurrentVersion": args.minimum_current_version,
        "mandatory": bool(args.mandatory),
        "releaseNotes": args.release_notes,
    }

    text = json.dumps(manifest, indent=2) + "\n"
    if args.out == "-":
        sys.stdout.write(text)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {args.out} ({manifest['appSizeBytes']:,} bytes, sha256 {manifest['sha256']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
