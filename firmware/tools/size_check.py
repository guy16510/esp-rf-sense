#!/usr/bin/env python3
"""Fail the build if the application image uses too much of one OTA slot.

The custom 4 MB partition table gives each app slot 0x1f0000 bytes (~1.94 MB). We require at
least 15% headroom (default --max-percent 85) so future OTA images still fit and so a growing
binary is caught in CI rather than at flash time.

Usage:
    python firmware/tools/size_check.py --app build/rf-sense.bin
    python firmware/tools/size_check.py --app build/rf-sense.bin --slot-size 0x1f0000 \\
        --max-percent 85
"""
from __future__ import annotations

import argparse
import os
import sys

DEFAULT_SLOT_SIZE = 0x1F0000  # one app slot from firmware/partitions.csv
DEFAULT_MAX_PERCENT = 85.0


def parse_size(value: str) -> int:
    """Accepts decimal or 0x-prefixed hex."""
    return int(value, 0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="path to the built application .bin")
    parser.add_argument("--slot-size", type=parse_size, default=DEFAULT_SLOT_SIZE,
                        help="OTA app slot size in bytes (default 0x1f0000)")
    parser.add_argument("--max-percent", type=float, default=DEFAULT_MAX_PERCENT,
                        help="maximum allowed slot utilization (default 85)")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.app):
        print(f"error: app image not found: {args.app}", file=sys.stderr)
        return 2

    size = os.path.getsize(args.app)
    threshold = int(args.slot_size * args.max_percent / 100.0)
    percent = 100.0 * size / args.slot_size

    print(f"app image:      {args.app}")
    print(f"app size:       {size:,} bytes")
    print(f"slot size:      {args.slot_size:,} bytes")
    print(f"utilization:    {percent:.2f}%")
    print(f"limit:          {args.max_percent:.0f}% ({threshold:,} bytes)")

    if size > threshold:
        print(f"FAIL: image exceeds {args.max_percent:.0f}% of the OTA slot "
              f"({size:,} > {threshold:,} bytes)", file=sys.stderr)
        return 1
    print("OK: image fits with the required headroom")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
