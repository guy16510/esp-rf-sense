# Node production runtime

The live RF dashboard runs entirely in Node.js. Python is not required to collect CSI, classify aggregate activity, stream updates, display the D3 scene, or record timeline events.

## Start the dashboard

```bash
npm ci
npm run dashboard:device
```

Open `http://127.0.0.1:8080/`.

To open the dashboard from a phone on the same Wi-Fi, run:

```bash
npm run dashboard:phone
```

Then open `http://<this-computer-ip>:8080/` on the phone.

The Node process:

- receives ESP32 CSI datagrams over UDP
- validates the RFCS protocol and CRC
- converts raw CSI into amplitude windows
- calculates motion and activity confidence
- optionally runs a portable model
- publishes state through HTTP and Server-Sent Events every 200 ms
- serves the reusable D3 dashboard
- records campaign and interaction markers in the live timeline
- optionally proxies recent firmware logs from the device control API

Useful options:

```text
--udp-host 0.0.0.0
--udp-port 5566
--http-host 127.0.0.1
--http-port 8080
--interval-ms 200
--window 64
--motion-threshold 1.25
--model models/live.json
--device http://rf-sense-a1b2.local
```

The `dashboard:device` and `dashboard:phone` scripts default to `http://rf-sense-a1b2.local`.
Override that with `RF_SENSE_DEVICE=http://your-device.local npm run dashboard:device`.

`--device` may also be supplied as `RF_SENSE_DEVICE`. When set, the dashboard polls
`/api/v1/logs` on the ESP32 and forwards new log lines to the browser as `log` SSE events.
Logs are not part of the RFCS CSI datagrams.

## Optional offline model development

Python remains an offline research tool for feature experiments, cross-validation, and model export. It is not part of the deployed dashboard.

Export a portable nearest-prototype model:

```bash
cd tools/analysis
pip install -e ".[dev]"
python -m rfsense_analysis.portable ../../recordings \
  --target position \
  --out ../../models/live.json
cd ../..
```

Run that model in Node:

```bash
npm run dashboard:start -- --model models/live.json
```

The default Node heuristic intentionally reports anonymous RF activity rather than claiming exact people, pose, identity, or orientation. A portable model may add a validated coarse label or zone, but the visualization must retain confidence and uncertainty.
