# Device, collector IP, and OTA onboarding

Open the dashboard guide at:

```text
http://YOUR_DASHBOARD:8080/device-onboarding.html
```

## First provisioning

1. Power one ESP32 at a time.
2. Join its `RF-Sense-...` access point.
3. Open `http://192.168.4.1`.
4. Configure Wi-Fi, collector host, collector UDP port `5566`, OTA manifest URL, channel, and a unique device name.
5. Repeat for all four nodes.

Use DHCP reservations for the dashboard server and receivers. This prevents routine address changes from taking the system offline.

## Change the dashboard or collector IP

Changing the collector IP is configuration, not a firmware update. From the repository root, run once per receiver:

```bash
npm --workspace @rf-sense/cli run configure -- \
  --host rf-sense-a1b2.local \
  --collector-host 192.168.1.25 \
  --collector-port 5566
```

The command performs three guarded operations:

1. Saves the new collector target through `POST /api/v1/config`.
2. Reads `GET /api/v1/config` and verifies the exact host and port.
3. Requests `POST /api/v1/reboot` only after verification succeeds.

Repeat for nodes A, B, C, and D.

## OTA firmware update

The firmware already includes dual OTA slots, manifest validation, SHA-256 image verification, boot validation, and rollback.

```bash
npm --workspace @rf-sense/cli run ota -- check --host rf-sense-a1b2.local
npm --workspace @rf-sense/cli run ota -- apply --host rf-sense-a1b2.local
```

Update one node at a time. Confirm that it returns to the dashboard before updating the next receiver.

## Recovery

When a node is still reachable, reset its provisioning with:

```text
POST http://NODE/api/v1/provisioning/reset
```

The device reboots into SoftAP mode. Join its RF-Sense network and open `192.168.4.1` again.

## Validation gate

Before collecting training data, confirm:

- dashboard reports `4 / 4 ready`
- all receivers have fresh CSI frames and non-zero rates
- all four collector targets match the dashboard server
- all four firmware versions match
- room dimensions and receiver placement are saved
- empty-room, trained-location, and held-out validation recordings exist

Do not treat the coarse-zone fallback as validated continuous XY.
