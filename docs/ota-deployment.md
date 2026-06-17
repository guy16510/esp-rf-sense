# OTA deployment

Once a device has been bootstrapped and provisioned, every firmware update is delivered over
**HTTPS OTA of the app slot**. There is no USB step for normal updates. This document covers how
images are published and applied; [ota-recovery.md](ota-recovery.md) covers what happens when an
update goes wrong.

## What OTA does and does not touch

OTA writes **only the inactive application slot** (`ota_0` ↔ `ota_1`) and then flips the boot
selector in otadata after the image is fully verified. It **never** rewrites the bootloader,
the partition table, otadata directly, NVS, or PHY data. Those require a physical bootstrap
flash ([initial-bootstrap.md](initial-bootstrap.md)). This is why the partition layout has two
equal app slots and a `CI` budget that keeps each app under 85% of a slot.

## Manifest-first validation

The device downloads a small JSON **manifest** and fully validates it *before* fetching any
firmware bytes. The manifest model and the accept/reject order live in
`firmware/components/ota_manager/include/OtaManifest.h`; the server-side equivalents are in
`tools/ota-server/src/manifest.ts` and `gen_manifest.py`. Keep all three in sync.

A manifest is **rejected** (first failing check wins) when:

| Reject reason | Meaning |
|---|---|
| `SchemaUnsupported` | `schemaVersion` newer than the device understands |
| `WrongProject` | `project` ≠ `rf-sense` |
| `WrongTarget` | `target` ≠ `esp32s3` |
| `WrongBoard` | `board` ≠ `esp32-s3-wroom-1-n4r8` |
| `WrongFlashLayout` | `flashSizeBytes` ≠ device flash |
| `BadVersion` | `version` not parseable as semver |
| `NotNewer` | `version` not greater than the running version |
| `BelowMinimum` | running version below the manifest's `minimumCurrentVersion` |
| `ImageTooLarge` | `appSizeBytes` exceeds the inactive slot |
| `MissingSha` | no/short SHA-256 |
| `InsecureUrl` | non-`https://` URL while insecure HTTP is disallowed (the default) |

Additional runtime gates beyond the manifest: a TLS handshake failure aborts the update; an OTA
already in progress is refused (single-flight lock); low free heap aborts; and an OTA is refused
while an experiment/capture is active.

## SHA-256 over the wire

The image is streamed through an **incremental mbedTLS SHA-256** in the HTTP event handler as it
is written to the inactive slot. The boot partition is switched **only after** the computed
digest matches the manifest's `sha256`. A truncated or corrupted download therefore never
becomes bootable.

## Triggering an update

Updates are always explicit. There is an optional scheduled check, **disabled by default**, and
`autoApply` is **off by default** — the device never auto-applies and never updates during an
active experiment.

From the CLI:

```bash
# point at a device by mDNS name or IP
export RF_SENSE_DEVICE=rf-sense-a1b2.local

npm run device:ota:check    # downloads + validates the manifest, reports availability (exit 3 = none)
npm run device:ota:apply    # re-checks, then applies; exit 0 once the device accepts (HTTP 202)
```

Or directly against the API:

```
POST /api/v1/ota/check
POST /api/v1/ota/apply
```

The device's `ota` state is visible in `GET /api/v1/status`:
`idle → checking → update_available → applying → ready_to_reboot → (reboot)`, or `failed`.

## OTA ↔ capture coordination

To avoid corrupting a recording or streaming during a flash write, an apply runs this sequence:

1. refuse if an experiment is active;
2. stop pings;
3. disable CSI capture;
4. explicitly drain and **discard** queued frames;
5. set the `maintenance` flag in outgoing telemetry so the collector marks the gap;
6. perform the OTA, then reboot;
7. on the new image, run startup validation;
8. resume CSI capture **only after** the image is marked healthy.

## Publishing images

- **CI** builds the image, enforces the size budget, and generates manifests. The development
  manifest is produced on every push by [firmware-ci.yml](../.github/workflows/firmware-ci.yml).
- **Releases** (`v*.*.*` tags) rebuild from the tag and attach `rf-sense-<ver>.bin`, the
  bootstrap bundle, `stable.json`, and `SHA256SUMS` via
  [release.yml](../.github/workflows/release.yml). The tag must match `firmware/version.txt`.
- **Promotion** to the live stable server is the manual
  [deploy-ota.yml](../.github/workflows/deploy-ota.yml): it downloads an existing release,
  re-verifies SHA256SUMS, uploads the firmware **first**, then atomically renames the stable
  manifest into place so a polling device never reads a manifest that points at a not-yet-present
  file. It **never rebuilds**.

## Running the OTA server

```bash
RF_SENSE_OTA_ROOT=/srv/ota \
RF_SENSE_TLS_CERT=certs/server.crt RF_SENSE_TLS_KEY=certs/server.key \
npm run ota-server:start
```

The server validates the OTA root at startup (every manifest must reference a present firmware
file whose SHA-256 and target match) and refuses to start otherwise. Plain HTTP is refused
unless `RF_SENSE_OTA_ALLOW_HTTP=1` is set explicitly (development only). See
[tools/ota-server/certs/README.md](../tools/ota-server/certs/README.md) for generating a local
root CA + server certificate, and [security-decisions.md](security-decisions.md) for the trust
model.
