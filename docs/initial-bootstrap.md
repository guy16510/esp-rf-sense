# Initial bootstrap flash (USB, once)

A factory-fresh or fully erased ESP32-S3 has to be brought up by **one** physical USB flash.
This writes the four things OTA can never touch — bootloader, partition table, initial otadata,
and the first app image — after which the device runs headless and every later update is HTTPS
OTA of the app slot. This is the only step that requires a cable.

## Where the bundle comes from

The bootstrap bundle is produced by the build/CI machine, never hand-assembled. After an
ESP-IDF build:

```bash
python firmware/tools/build_bootstrap_bundle.py --build-dir firmware/build --out dist/bootstrap
```

This reads `flasher_args.json` from the build (so offsets always match the build), copies the
four binaries, merges them into a single image with the official esptool `merge_bin`, and emits
flash scripts plus `SHA256SUMS`. The same bundle is attached to every GitHub Release by
[release.yml](../.github/workflows/release.yml).

`dist/bootstrap/` contains:

| File | Purpose |
|---|---|
| `bootloader.bin` | second-stage bootloader |
| `partition-table.bin` | the custom 4 MB table (`firmware/partitions.csv`) |
| `ota_data_initial.bin` | initial otadata (selects `ota_0` for first boot) |
| `rf-sense.bin` | the application image |
| `rf-sense-bootstrap-combined.bin` | all of the above merged for a single `write_flash 0x0` |
| `flash_args.json` | offsets + canonical filenames describing the bundle |
| `flash-bootstrap.sh` / `.ps1` | guarded flash scripts (Linux/macOS and Windows) |
| `SHA256SUMS` | checksums for every file above |

## Flashing

Connect the board over USB, then from `dist/bootstrap/`:

```bash
# Linux / macOS
PORT=/dev/ttyUSB0 ./flash-bootstrap.sh

# full chip erase first (only when you intend to wipe NVS/config too)
PORT=/dev/ttyUSB0 ERASE=1 ./flash-bootstrap.sh
```

```powershell
# Windows PowerShell
$env:PORT="COM5"; ./flash-bootstrap.ps1
```

The scripts:

1. Run `flash_id` first — **esptool aborts if the connected chip is not ESP32-S3**, so you
   cannot flash this image onto the wrong target. The detected flash size is printed.
2. Erase the whole chip **only** when you set `ERASE=1` (otherwise NVS/config survive).
3. Flash the combined image at `0x0`, then read the MAC.
4. Print the MAC — the last two bytes form the device id (e.g. `RF-Sense-A1B2`) — and remind you
   to provision over Wi-Fi.

## Verify before flashing

Always check the bundle against its checksums first:

```bash
cd dist/bootstrap && sha256sum -c SHA256SUMS
```

For a release downloaded from GitHub, the release's `SHA256SUMS` covers the same files; verify
them before trusting the image.

## What happens after first boot

The freshly flashed device boots **unprovisioned**: `ota_0` is the active app, otadata is clean,
NVS holds no Wi-Fi or collector settings. It immediately raises the `RF-Sense-XXXX` SoftAP for
provisioning — continue with [wifi-provisioning.md](wifi-provisioning.md).

## When you must bootstrap again (rare)

Only changes to the parts OTA cannot update require another USB flash:

- bootloader changes,
- partition-table layout changes (`firmware/partitions.csv`),
- recovering a device that has no working app in either slot and cannot be reached over Wi-Fi.

Routine firmware changes never need this — use OTA ([ota-deployment.md](ota-deployment.md)).
