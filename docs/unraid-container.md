# Unraid container

The RF-Sense dashboard can run as an Unraid Docker application. The image receives CSI datagrams from all four ESP32 receivers, serves the dashboard, stores calibration recordings, and persists trained models.

## Published image

GitHub Actions builds and smoke-tests the image before publishing it to:

```text
ghcr.io/guy16510/esp-rf-sense:latest
```

A successful push to `main` updates `latest`. Version tags also publish a matching versioned image and every publication receives a `sha-<commit>` tag.

The smoke test starts the real container, verifies `/api/readiness`, loads `/fleet`, and confirms that recordings and model directories are writable through the mounted data path.

## First-time GHCR access

GitHub Container Registry packages are commonly private on first publication.

For a private package, authenticate Unraid once from its terminal:

```bash
docker login ghcr.io -u guy16510
```

Use a GitHub personal access token with `read:packages` as the password. Do not put the token in the XML template.

Alternatively, change the package visibility to public in GitHub Packages and Unraid can pull it without credentials.

## Install from the template

The Unraid template is stored at:

```text
https://raw.githubusercontent.com/guy16510/esp-rf-sense/main/deploy/unraid/rf-sense.xml
```

In Unraid:

1. Open the Docker tab and choose **Add Container**.
2. Switch to advanced view.
3. Paste the template URL, or create a template using the values below.
4. Keep the application data mapping at `/mnt/user/appdata/rf-sense` unless your appdata share is elsewhere.
5. Map dashboard TCP port `8080` and CSI UDP port `5566`.
6. Confirm the four receiver device IDs match the IDs shown by the dashboard or hardware identification command.
7. Apply the container and open `http://<unraid-ip>:8080/fleet`.

## Required ESP32 configuration

Every receiver must send CSI to the Unraid server LAN address, not the container bridge address.

```text
collector host: <unraid LAN IP>
collector port: 5566
protocol: UDP
```

The Docker bridge forwards UDP `5566` into the RF-Sense process. The dashboard listens on TCP `8080`.

## Persistent data

The template maps `/data` to `/mnt/user/appdata/rf-sense`.

```text
/data/recordings/                    captured calibration sessions
/data/models/dashboard-position.json trained XY model
```

The entrypoint creates both directories on startup. When `RF_SENSE_AUTO_LOAD_MODEL=true`, an existing model is loaded automatically after a container restart or upgrade.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `RF_SENSE_REQUIRED_NODES` | `4` | Number of receiver streams required before recording is enabled |
| `RF_SENSE_MIN_FRAME_RATE` | `5` | Minimum healthy frame rate for each receiver |
| `RF_SENSE_AUTO_LOAD_MODEL` | `true` | Load the persisted position model at startup when it exists |
| `RF_SENSE_SLOT_A` | `2f4b47f0` | Device ID assigned to room slot A |
| `RF_SENSE_SLOT_B` | `2f4b5390` | Device ID assigned to room slot B |
| `RF_SENSE_SLOT_C` | `2f4b735c` | Device ID assigned to room slot C |
| `RF_SENSE_SLOT_D` | `2f77883c` | Device ID assigned to room slot D |
| `RF_SENSE_INTERVAL_MS` | `200` | Dashboard stream update interval |
| `RF_SENSE_RECORDINGS_DIR` | `/data/recordings` | Recording storage path |
| `RF_SENSE_MODEL_PATH` | `/data/models/dashboard-position.json` | Persisted model path |

## Updating

After a successful `main` build publishes a new `latest` image:

1. In Unraid, select **Check for Updates** on the Docker page.
2. Update the RF-Sense container.
3. Confirm the dashboard opens and the four receiver IDs are unchanged.
4. Confirm the prior recordings and model are still present under the appdata mapping.

For deterministic rollback, replace `latest` with a known `sha-<commit>` or version tag in the repository field.

## Local equivalent

The same container can be built and started outside Unraid:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:8080/fleet` and configure the ESP32 receivers to send UDP to the Docker host on port `5566`.
