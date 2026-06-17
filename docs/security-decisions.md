# Security decisions

This is a research lab on a trusted LAN, not a fielded product. The security posture is chosen to
be **honest and safe-by-default for that context**, while clearly marking what additional
hardening a production deployment would need. Nothing here silently weakens TLS, and no decision
relies on a "skip validation" path.

## Threat model (what we are and aren't defending)

- **In scope:** preventing accidental insecure OTA transport, preventing a
  corrupted/wrong/downgraded firmware image from being installed, and never logging secrets.
- **Out of scope for this milestone:** a physically hostile attacker with the board in hand
  (flash readout, fault injection), and a fully untrusted network. Those need secure boot + flash
  encryption + anti-rollback, which are intentionally **not** auto-enabled here (see below).

## Transport

- **OTA is HTTPS-only by default.** The OTA manager refuses any manifest or firmware URL that is
  not `https://`. Plain HTTP is allowed only when the firmware is built with
  `CONFIG_RF_SENSE_OTA_ALLOW_INSECURE_HTTP=y` (default `n`, development only). Release builds keep
  it off.
- **TLS server verification is always performed.** There is **no** "skip certificate validation"
  option anywhere in the codebase. The default trust model embeds a **private root CA** for the
  local OTA server; the `esp_crt_bundle` path is also wired for a public HTTPS endpoint. See
  `firmware/components/ota_manager/certs/` and
  [tools/ota-server/certs/README.md](../tools/ota-server/certs/README.md).
- The CSI stream itself is **plaintext UDP** on a trusted LAN — it carries no secrets, only raw
  channel measurements, and is volume-sensitive. Confidentiality of CSI is not a goal; if it
  becomes one, the transport would need to change.

## Local control

- The control API is exposed on the trusted LAN without token authentication. This is a research
  convenience, not a production posture.
- Any host that can reach the device can start/stop capture, change config, trigger OTA, reboot,
  or reset provisioning. Keep the device on a trusted lab network.

## Firmware integrity

- **Manifest-first, then SHA-256.** The device validates a small manifest (schema, project,
  target, board, flash layout, newer-version, size, https) before downloading, then verifies the
  image with an **incremental SHA-256** as it streams. The boot partition is switched only after
  the digest matches. See [ota-deployment.md](ota-deployment.md).
- **App slot only.** OTA never rewrites the bootloader, partition table, otadata directly, NVS,
  or PHY. Those require a physical bootstrap flash, which limits the blast radius of a bad update.
- **Downgrade protection (logical).** The manifest's `NotNewer` and `minimumCurrentVersion`
  checks refuse older images. This is a *policy* check, not an irreversible hardware anti-rollback
  fuse (see below).

## Secrets handling

- The Wi-Fi password is stored in NVS and **never written to any log** at any level; the
  provisioning page never echoes it.
- The OTA deploy workflow keeps the server address and SSH key in environment secrets, writes the
  key to a mode-600 file, and pins `known_hosts`; nothing sensitive lives in the repo.

## Deliberately NOT enabled (and why)

| Feature | Status | Why |
|---|---|---|
| Secure Boot v2 | off | irreversible eFuse burn; wrong for a reflashable research board |
| Flash encryption | off | irreversible; complicates debugging/coredump readout |
| Anti-rollback eFuse | off | permanent; we use *logical* version checks instead |

These are the correct **production hardening** steps and should be enabled before any deployment
where the device is physically exposed or the network is untrusted. They are left off here on
purpose so the board stays reflashable and debuggable during research — this is a conscious
trade-off, documented rather than hidden.

## What a production deployment would add

Secure Boot v2 + flash encryption + anti-rollback eFuse; per-device provisioned credentials;
signed manifests (signature in addition to SHA-256); and encrypted/authenticated transport for
the CSI stream if its confidentiality ever matters.
