# Wi-Fi provisioning (headless)

After the one-time bootstrap flash, the device has no Wi-Fi credentials and no collector/OTA
settings. It provisions itself over a temporary access point — there is no mobile app and no
USB step. This is the `provisioning` component plus a minimal setup page.

## Flow

```
first boot / cleared config
        │
        ▼
 SoftAP "RF-Sense-XXXX"  (XXXX = last two MAC bytes; password configurable)
        │   join it, browse to http://192.168.4.1
        ▼
 setup page: SSID, Wi-Fi password, OTA manifest URL, OTA channel,
             collector host/IP, collector UDP port, device name
        │
        ▼
 device tests the STA connection
        │            ┌─ fail → stays in SoftAP, shows the error, lets you retry
        ▼ success    │
 store in NVS (Wi-Fi password NEVER logged) → stop SoftAP → restart in STA mode
        │
        ▼
 joins the LAN, advertises rf-sense-<id>.local, ready for capture + OTA
```

## What you set

| Field | Notes |
|---|---|
| Wi-Fi SSID + password | the 2.4 GHz network the device and collector share |
| Collector host / IP | where raw CSI datagrams are sent |
| Collector UDP port | default `5566` |
| OTA manifest URL | e.g. `https://rf-sense-ota.local:8443/manifest/stable.json` |
| OTA channel | `stable` or `development` |
| Device name | human label surfaced in `/api/v1/status` and mDNS |

Defaults (applied when NVS holds no value) live in `firmware/main/AppConfig.h`:
control port `80`, collector port `5566`, ping rate `25` pps.

## Secrets handling

- The Wi-Fi password is stored in NVS and **never written to any log** at any level. The setup
  page never echoes it back.
- `GET /api/v1/config` returns `wifiPasswordSet` instead of the password itself — you can confirm
  a value is present without it ever leaving the device.

## Connecting to the device afterward

The device advertises `rf-sense-<id>.local` over mDNS with its firmware version, API version,
device id, target, capture state, and OTA state. Discover it with:

```bash
npm run device:discover
npm run device:status -- --host rf-sense-a1b2.local
```

mDNS is a convenience, never a requirement: every tool also accepts a direct IP via `--host`
(or `RF_SENSE_DEVICE`). If mDNS is filtered on your network, use the IP the device got from
DHCP.

## Clearing provisioning

To return a device to the unprovisioned SoftAP state (e.g. moving it to a new network):

- **API:** `POST /api/v1/provisioning/reset`.
- **Serial command:** over the USB console, if attached.
- **Button hold:** a configurable button-hold, if the board exposes a usable button.

Clearing provisioning wipes Wi-Fi and collector/OTA settings from NVS and reboots into the
SoftAP. A full chip erase during a re-bootstrap (`ERASE=1`) has the same effect plus wipes
everything else.
