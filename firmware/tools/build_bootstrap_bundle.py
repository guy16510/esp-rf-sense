#!/usr/bin/env python3
"""Assemble the one-time USB bootstrap flash bundle from an ESP-IDF build directory.

A device can only be brought up by one physical flash of the bootloader + partition table +
otadata + initial app. After that, every further update is HTTPS OTA of the app slot only.
This script gathers those four binaries, merges them into a single combined image with the
official esptool ``merge_bin``, and emits cross-platform flash scripts + SHA256SUMS.

It reads ``flasher_args.json`` (produced by ``idf.py build``) so the offsets always match the
build, and it runs on the build/CI machine where esptool is available -- not on the authoring
machine. Output lands in ``dist/bootstrap/``.

Usage:
    python firmware/tools/build_bootstrap_bundle.py --build-dir firmware/build
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

# Map the IDF build filename to the canonical name we publish in the bundle.
CANONICAL_NAMES = {
    "bootloader.bin": "bootloader.bin",
    "partition-table.bin": "partition-table.bin",
    "ota_data_initial.bin": "ota_data_initial.bin",
}
APP_CANONICAL = "rf-sense.bin"
COMBINED_NAME = "rf-sense-bootstrap-combined.bin"


def canonical_for(rel_path: str) -> str:
    base = os.path.basename(rel_path)
    if base in CANONICAL_NAMES:
        return CANONICAL_NAMES[base]
    # Anything else is the application image.
    return APP_CANONICAL


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def esptool_cmd() -> list[str]:
    if shutil.which("esptool.py"):
        return ["esptool.py"]
    return [sys.executable, "-m", "esptool"]


def load_flasher_args(build_dir: str) -> dict:
    path = os.path.join(build_dir, "flasher_args.json")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"flasher_args.json not found in {build_dir}; run idf.py build")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", default="firmware/build")
    parser.add_argument("--out", default="dist/bootstrap")
    parser.add_argument("--chip", default="esp32s3")
    args = parser.parse_args(argv)

    flasher = load_flasher_args(args.build_dir)
    flash_files: dict[str, str] = flasher["flash_files"]
    settings = flasher.get("flash_settings", {})
    flash_mode = settings.get("flash_mode", "dio")
    flash_freq = settings.get("flash_freq", "80m")
    flash_size = settings.get("flash_size", "4MB")

    os.makedirs(args.out, exist_ok=True)

    # offset (int) -> canonical filename, copying each binary into the bundle.
    ordered: list[tuple[int, str]] = []
    for offset_str, rel in sorted(flash_files.items(), key=lambda kv: int(kv[0], 0)):
        offset = int(offset_str, 0)
        src = os.path.join(args.build_dir, rel)
        if not os.path.isfile(src):
            print(f"error: missing build artifact {src}", file=sys.stderr)
            return 2
        name = canonical_for(rel)
        shutil.copy2(src, os.path.join(args.out, name))
        ordered.append((offset, name))

    # Build the combined image with esptool merge_bin.
    combined_path = os.path.join(args.out, COMBINED_NAME)
    merge = esptool_cmd() + [
        "--chip", args.chip, "merge_bin", "-o", combined_path,
        "--flash_mode", flash_mode, "--flash_freq", flash_freq, "--flash_size", flash_size,
    ]
    for offset, name in ordered:
        merge += [hex(offset), os.path.join(args.out, name)]
    print("running:", " ".join(merge))
    subprocess.run(merge, check=True)

    # Our own flash_args.json describing the bundle (offsets + canonical filenames).
    flash_args = {
        "chip": args.chip,
        "flash_mode": flash_mode,
        "flash_freq": flash_freq,
        "flash_size": flash_size,
        "combined_image": COMBINED_NAME,
        "combined_offset": "0x0",
        "files": {hex(off): name for off, name in ordered},
    }
    with open(os.path.join(args.out, "flash_args.json"), "w", encoding="utf-8") as fh:
        json.dump(flash_args, fh, indent=2)
        fh.write("\n")

    write_flash_scripts(args.out, args.chip)
    write_sha256sums(args.out)

    print(f"\nbootstrap bundle ready in {args.out}/")
    print(f"  combined image: {COMBINED_NAME} (flash at 0x0)")
    return 0


def write_flash_scripts(out_dir: str, chip: str) -> None:
    sh = f"""#!/usr/bin/env bash
# One-time bootstrap flash for the RF-Sense device. Safe to re-run.
#   PORT=/dev/ttyUSB0 ./flash-bootstrap.sh        # flash without erasing
#   PORT=/dev/ttyUSB0 ERASE=1 ./flash-bootstrap.sh # full chip erase first
set -euo pipefail
DIR="$(cd "$(dirname "${{BASH_SOURCE[0]}}")" && pwd)"
CHIP="{chip}"
ESPTOOL="esptool.py"
command -v "$ESPTOOL" >/dev/null 2>&1 || ESPTOOL="python -m esptool"
PORT_ARG=""
[ -n "${{PORT:-}}" ] && PORT_ARG="--port ${{PORT}}"

echo "==> Verifying chip is $CHIP and reading flash..."
# esptool aborts here if the connected chip is not $CHIP, refusing unsupported targets.
$ESPTOOL --chip "$CHIP" $PORT_ARG flash_id

if [ "${{ERASE:-0}}" = "1" ]; then
  echo "==> Erasing flash (explicitly requested)..."
  $ESPTOOL --chip "$CHIP" $PORT_ARG erase_flash
fi

echo "==> Flashing combined bootstrap image at 0x0..."
$ESPTOOL --chip "$CHIP" $PORT_ARG write_flash 0x0 "$DIR/{COMBINED_NAME}"

echo "==> Device MAC (last 2 bytes form the device id, e.g. RF-Sense-A1B2):"
$ESPTOOL --chip "$CHIP" $PORT_ARG read_mac

cat <<'EOF'

Done. The device now boots unprovisioned and exposes a Wi-Fi access point named
RF-Sense-XXXX (XXXX = last two MAC bytes). Join it and open http://192.168.4.1 to set the
Wi-Fi SSID/password, collector host, OTA manifest URL, and admin token. All later firmware
updates are delivered over HTTPS OTA -- no USB needed.
EOF
"""
    ps1 = f"""# One-time bootstrap flash for the RF-Sense device (Windows PowerShell). Safe to re-run.
#   $env:PORT="COM5"; ./flash-bootstrap.ps1
#   $env:PORT="COM5"; $env:ERASE="1"; ./flash-bootstrap.ps1
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Chip = "{chip}"
$Esptool = if (Get-Command esptool.py -ErrorAction SilentlyContinue) {{ "esptool.py" }} else {{ "python -m esptool" }}
$PortArg = if ($env:PORT) {{ "--port $($env:PORT)" }} else {{ "" }}

Write-Host "==> Verifying chip is $Chip and reading flash..."
Invoke-Expression "$Esptool --chip $Chip $PortArg flash_id"

if ($env:ERASE -eq "1") {{
  Write-Host "==> Erasing flash (explicitly requested)..."
  Invoke-Expression "$Esptool --chip $Chip $PortArg erase_flash"
}}

Write-Host "==> Flashing combined bootstrap image at 0x0..."
Invoke-Expression "$Esptool --chip $Chip $PortArg write_flash 0x0 `"$Dir/{COMBINED_NAME}`""

Write-Host "==> Device MAC (last 2 bytes form the device id, e.g. RF-Sense-A1B2):"
Invoke-Expression "$Esptool --chip $Chip $PortArg read_mac"

Write-Host ""
Write-Host "Done. Join the RF-Sense-XXXX Wi-Fi AP and open http://192.168.4.1 to provision."
Write-Host "All later firmware updates are delivered over HTTPS OTA -- no USB needed."
"""
    sh_path = os.path.join(out_dir, "flash-bootstrap.sh")
    with open(sh_path, "w", encoding="utf-8") as fh:
        fh.write(sh)
    os.chmod(sh_path, 0o755)
    with open(os.path.join(out_dir, "flash-bootstrap.ps1"), "w", encoding="utf-8") as fh:
        fh.write(ps1)


def write_sha256sums(out_dir: str) -> None:
    lines = []
    for name in sorted(os.listdir(out_dir)):
        if name == "SHA256SUMS":
            continue
        path = os.path.join(out_dir, name)
        if os.path.isfile(path):
            lines.append(f"{sha256_of(path)}  {name}")
    with open(os.path.join(out_dir, "SHA256SUMS"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
