import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bonjour } from 'bonjour-service';

export const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:8080';
export const DEFAULT_ROOM_CONFIG = 'config/hardware-room.json';
export const DEFAULT_ARTIFACT_DIR = 'artifacts/hardware/latest';
export const REQUIRED_SLOTS = ['A', 'B', 'C', 'D'];

export function parseArgs(argv) {
  const values = new Map();
  const lists = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? next : 'true';
    if (value !== 'true') index += 1;
    if (lists.has(key) || values.has(key)) {
      const list = lists.get(key) ?? [values.get(key)];
      list.push(value);
      values.delete(key);
      lists.set(key, list);
    } else {
      values.set(key, value);
    }
  }
  return { values, lists };
}

export function argNumber(values, key, fallback) {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
}

export function normalizeBaseUrl(value) {
  if (!value) throw new Error('device URL is required');
  return /^https?:\/\//u.test(value) ? value.replace(/\/$/u, '') : `http://${value}`;
}

export function normalizeDeviceId(value) {
  const parsed =
    typeof value === 'number'
      ? (value >>> 0).toString(16)
      : String(value ?? '').toLowerCase().replace(/^0x/u, '');
  const clean = parsed.padStart(8, '0');
  if (!/^[0-9a-f]{8}$/u.test(clean)) throw new Error(`invalid device ID: ${value}`);
  return clean;
}

export async function getJson(baseUrl, path, timeoutMs = 8000) {
  const response = await fetch(new URL(path, normalizeBaseUrl(baseUrl)), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${baseUrl}${path} HTTP ${response.status}: ${text}`);
  return json;
}

export async function postJson(baseUrl, path, body = {}, timeoutMs = 8000) {
  const response = await fetch(new URL(path, normalizeBaseUrl(baseUrl)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${baseUrl}${path} HTTP ${response.status}: ${text}`);
  return json;
}

export async function discoverReceivers(timeoutMs = 5000) {
  const bonjour = new Bonjour();
  const found = new Map();
  const browser = bonjour.find({ type: 'http' }, (service) => {
    const txt = service.txt ?? {};
    const name = service.name ?? '';
    if (!/^rf-sense/iu.test(name) && typeof txt.id !== 'string') return;
    const address = service.addresses?.find((item) => /^\d+\.\d+\.\d+\.\d+$/u.test(item));
    const host = address ?? service.host;
    if (!host) return;
    const id = txt.id ? normalizeDeviceId(txt.id) : normalizeDeviceId(name.slice(-4));
    found.set(id, {
      id,
      name,
      host: service.host ?? host,
      url: `http://${host}:${service.port ?? 80}`,
      addresses: service.addresses ?? [],
      txt,
    });
  });
  await delay(timeoutMs);
  browser.stop();
  bonjour.destroy();
  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function inventoryReceiver(url) {
  const [status, health, config] = await Promise.all([
    getJson(url, '/api/v1/status'),
    getJson(url, '/api/v1/health'),
    getJson(url, '/api/v1/config'),
  ]);
  return {
    url: normalizeBaseUrl(url),
    deviceId: normalizeDeviceId(status.deviceId),
    deviceName: status.deviceName ?? config.deviceName ?? null,
    firmwareVersion: status.firmware?.version ?? null,
    firmwareGitCommit: status.firmware?.gitCommit ?? null,
    target: status.firmware?.target ?? null,
    board: status.firmware?.board ?? null,
    protocolVersion: status.firmware?.protocolVersion ?? null,
    captureState: status.capture?.active ? 'active' : 'idle',
    collectorHost: config.collectorHost ?? null,
    collectorPort: config.collectorPort ?? null,
    captureMode: config.captureMode ?? null,
    pingPps: config.pingPps ?? null,
    rssi: health.currentRssi ?? null,
    csiFramesCaptured: health.csiFramesCaptured ?? null,
    queueDrops: health.csiQueueDrops ?? null,
    networkSendFailures: health.networkSendFailures ?? null,
    status,
    health,
    config,
  };
}

export function findMacLanIpv4() {
  const candidates = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(lo|utun|awdl|llw|bridge|docker|vbox|vmnet)/iu.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  if (candidates.length === 0) throw new Error('no Mac LAN IPv4 address found');
  return candidates[0];
}

export async function loadRoomConfig(path = DEFAULT_ROOM_CONFIG) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function saveRoomConfig(config, path = DEFAULT_ROOM_CONFIG) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function defaultCalibrationPoints(widthMeters, heightMeters) {
  return [
    { label: 'left', xMeters: widthMeters * 0.25, yMeters: heightMeters * 0.5 },
    { label: 'center', xMeters: widthMeters * 0.5, yMeters: heightMeters * 0.5 },
    { label: 'right', xMeters: widthMeters * 0.75, yMeters: heightMeters * 0.5 },
    { label: 'front', xMeters: widthMeters * 0.5, yMeters: heightMeters * 0.25 },
    { label: 'back', xMeters: widthMeters * 0.5, yMeters: heightMeters * 0.75 },
  ];
}

export function createRoomConfig({ widthMeters, heightMeters, receivers = {} }) {
  const width = positive(widthMeters, 'widthMeters');
  const height = positive(heightMeters, 'heightMeters');
  return {
    name: 'hardware-validation-room',
    widthMeters: width,
    heightMeters: height,
    origin: 'top-left',
    receivers,
    calibrationPoints: defaultCalibrationPoints(width, height),
  };
}

export function normalizeCalibrationPoint(config, point) {
  return {
    label: point.label,
    xMeters: point.xMeters,
    yMeters: point.yMeters,
    normalizedX: point.xMeters / config.widthMeters,
    normalizedY: point.yMeters / config.heightMeters,
  };
}

export function validateRoomConfig(config) {
  const width = positive(config.widthMeters, 'widthMeters');
  const height = positive(config.heightMeters, 'heightMeters');
  if (config.origin !== 'top-left') throw new Error('hardware room origin must be top-left');
  const receivers = config.receivers ?? {};
  const missingSlots = REQUIRED_SLOTS.filter((slot) => !receivers[slot]);
  if (missingSlots.length > 0) throw new Error(`room config missing receiver slots: ${missingSlots.join(', ')}`);
  const ids = REQUIRED_SLOTS.map((slot) => normalizeDeviceId(receivers[slot].deviceId));
  if (new Set(ids).size !== ids.length) throw new Error('receiver device IDs must be unique');
  for (const slot of REQUIRED_SLOTS) {
    const receiver = receivers[slot];
    pointInside(receiver, width, height, `receivers.${slot}`);
  }
  if (!Array.isArray(config.calibrationPoints) || config.calibrationPoints.length < 2) {
    throw new Error('room config needs at least two calibration points');
  }
  for (const point of config.calibrationPoints) pointInside(point, width, height, `calibrationPoints.${point.label}`);
  return config;
}

export function evaluatePlacement(config) {
  validateRoomConfig(config);
  const points = REQUIRED_SLOTS.map((slot) => config.receivers[slot]);
  const xs = points.map((point) => point.xMeters);
  const ys = points.map((point) => point.yMeters);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const ySpan = Math.max(...ys) - Math.min(...ys);
  const xCoverage = xSpan / config.widthMeters;
  const yCoverage = ySpan / config.heightMeters;
  const pass = xCoverage >= 0.5 && yCoverage >= 0.5;
  return {
    pass,
    xCoverage,
    yCoverage,
    message: pass
      ? 'receiver geometry is spread enough for calibrated-zone smoke testing'
      : 'receivers are clustered; stream validation is allowed, but position calibration claims are blocked',
  };
}

export function toDashboardRoomGeometry(config) {
  validateRoomConfig(config);
  return {
    format: 'rfsense-room-geometry/1',
    room: {
      name: config.name,
      widthMeters: config.widthMeters,
      heightMeters: config.heightMeters,
    },
    transmitter: {
      name: 'router',
      x: config.widthMeters / 2,
      y: 0,
    },
    receivers: REQUIRED_SLOTS.map((slot) => ({
      slot,
      deviceId: normalizeDeviceId(config.receivers[slot].deviceId),
      x: config.receivers[slot].xMeters,
      y: config.receivers[slot].yMeters,
    })),
    zones: Object.fromEntries(
      config.calibrationPoints.map((point) => [point.label, { x: point.xMeters, y: point.yMeters }]),
    ),
  };
}

export function encodedRecordingLabel(metadata) {
  return `rfsense-meta:${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`;
}

export async function fetchDashboardNodes(dashboardUrl = DEFAULT_DASHBOARD_URL) {
  return getJson(dashboardUrl, '/api/nodes');
}

export async function ensureFourReady(dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const snapshot = await fetchDashboardNodes(dashboardUrl);
  const nodes = snapshot.nodes ?? [];
  const ids = new Set(nodes.map((node) => node.deviceId).filter(Boolean));
  if (!snapshot.readiness?.readyForCapture || nodes.length !== 4 || ids.size !== 4) {
    throw new Error(`four receivers are not ready: ${snapshot.readiness?.reasons?.join('; ') || 'unknown readiness failure'}`);
  }
  return snapshot;
}

export function summarizeSamples(samples) {
  const byDevice = new Map();
  for (const sample of samples) {
    for (const node of sample.nodes ?? []) {
      const list = byDevice.get(node.deviceId) ?? [];
      list.push(node);
      byDevice.set(node.deviceId, list);
    }
  }
  return [...byDevice.entries()]
    .map(([deviceId, rows]) => {
      const frameRates = rows.map((row) => Number(row.frameRateHz)).filter(Number.isFinite);
      const losses = rows.map((row) => Number(row.lossPpm)).filter(Number.isFinite);
      const ages = rows.map((row) => Number(row.ageSec)).filter(Number.isFinite);
      const widths = rows.map((row) => Number(row.csiLength)).filter(Number.isFinite);
      return {
        deviceId,
        samples: rows.length,
        frameRateHz: stats(frameRates),
        lossPpm: stats(losses),
        ageSec: stats(ages),
        csiWidthChanges: Math.max(0, new Set(widths).size - 1),
        csiWidths: [...new Set(widths)].sort((left, right) => left - right),
        totalFrames: Math.max(...rows.map((row) => Number(row.frames) || 0)),
        readinessFailures: rows.filter((row) => !row.ready).length,
        reasons: [...new Set(rows.flatMap((row) => row.readinessReasons ?? []))],
      };
    })
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

export function streamReport(samples, options = {}) {
  const minFrameRateHz = options.minFrameRateHz ?? 5;
  const maxAgeSec = options.maxAgeSec ?? 1;
  const maxLossPpm = options.maxLossPpm ?? 100000;
  const latest = samples.at(-1) ?? {};
  const receivers = summarizeSamples(samples);
  const ids = new Set(receivers.map((receiver) => receiver.deviceId));
  const failures = [];
  if (receivers.length !== 4) failures.push(`expected 4 receivers, saw ${receivers.length}`);
  if (ids.size !== receivers.length) failures.push('duplicate receiver IDs observed');
  for (const receiver of receivers) {
    if ((receiver.frameRateHz.min ?? 0) < minFrameRateHz) failures.push(`${receiver.deviceId} frame rate below ${minFrameRateHz} Hz`);
    if ((receiver.ageSec.max ?? Infinity) > maxAgeSec) failures.push(`${receiver.deviceId} age above ${maxAgeSec}s`);
    if ((receiver.lossPpm.max ?? Infinity) > maxLossPpm) failures.push(`${receiver.deviceId} packet loss above ${maxLossPpm} ppm`);
    if (receiver.csiWidths.length === 0 || receiver.csiWidths.every((width) => width <= 0)) failures.push(`${receiver.deviceId} CSI width is zero`);
    if (receiver.readinessFailures > 0) failures.push(`${receiver.deviceId} had readiness failures`);
  }
  if (latest.fused?.invalidDatagrams > 0) failures.push('malformed datagrams observed');
  return {
    generatedAt: new Date().toISOString(),
    durationSeconds: samples.length > 1 ? samples.at(-1).timestamp - samples[0].timestamp : 0,
    pass: failures.length === 0,
    failures,
    receivers,
    latestReadiness: latest.readiness ?? null,
    slotDeviceIds: latest.slotDeviceIds ?? [],
  };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function artifactPath(name, artifactDir = DEFAULT_ARTIFACT_DIR) {
  return resolve(artifactDir, name);
}

function positive(value, path) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${path} must be a positive number`);
  return parsed;
}

function pointInside(point, width, height, path) {
  if (!point || typeof point !== 'object') throw new Error(`${path} is required`);
  const x = Number(point.xMeters);
  const y = Number(point.yMeters);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${path} needs finite xMeters/yMeters`);
  if (x < 0 || x > width || y < 0 || y > height) throw new Error(`${path} is outside room dimensions`);
}

function stats(values) {
  if (values.length === 0) return { min: null, median: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  };
}
