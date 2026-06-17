#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(new URL('.', import.meta.url).pathname, '..');
const envPath = resolve(root, '.env');
const outDir = resolve(root, 'build', 'configured-flash');
const cfgBlobPath = resolve(outDir, 'cfg.v1.bin');
const nvsCsvPath = resolve(outDir, 'nvs.csv');
const nvsBinPath = resolve(outDir, 'nvs.bin');
const bootstrapBin = resolve(root, 'dist', 'bootstrap', 'rf-sense-bootstrap-combined.bin');
const nvsGen = resolve(
  process.env.IDF_PATH ?? '/Users/admin/esp/esp-idf',
  'components',
  'nvs_flash',
  'nvs_partition_generator',
  'nvs_partition_gen.py',
);

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const env = { ...process.env, ...readEnv(envPath) };

const python =
  env.ESP_PYTHON ||
  firstExisting([
    '/Users/admin/.espressif/python_env/idf5.3_py3.9_env/bin/python',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ]) ||
  'python3';

const config = {
  wifiSsid: required(env, 'RF_SENSE_WIFI_SSID'),
  wifiPassword: env.RF_SENSE_WIFI_PASSWORD ?? '',
  otaManifestUrl: env.RF_SENSE_OTA_MANIFEST_URL ?? '',
  otaChannel: env.RF_SENSE_OTA_CHANNEL || 'stable',
  collectorHost: resolveCollectorHost(env.RF_SENSE_COLLECTOR_HOST),
  collectorPort: numberEnv(env, 'RF_SENSE_COLLECTOR_PORT', 5566, 1, 65535),
  deviceName: env.RF_SENSE_DEVICE_NAME || 'rf-sense',
  captureMode: numberEnv(env, 'RF_SENSE_CAPTURE_MODE', 0, 0, 2),
  pingPps: numberEnv(env, 'RF_SENSE_PING_PPS', 25, 1, 200),
  pingPayloadBytes: numberEnv(env, 'RF_SENSE_PING_PAYLOAD_BYTES', 32, 0, 65535),
  pingTimeoutMs: numberEnv(env, 'RF_SENSE_PING_TIMEOUT_MS', 500, 0, 65535),
  pingWarmupMs: numberEnv(env, 'RF_SENSE_PING_WARMUP_MS', 1000, 0, 0xffffffff),
};
validateConfig(config);

mkdirSync(outDir, { recursive: true });
writeFileSync(cfgBlobPath, encodeConfig(config));
writeFileSync(
  nvsCsvPath,
  [
    'key,type,encoding,value',
    'rfsense,namespace,,',
    `cfg.v1,file,binary,${cfgBlobPath}`,
    '',
  ].join('\n'),
);

run(python, [nvsGen, 'generate', nvsCsvPath, nvsBinPath, '0x6000']);

const port = resolvePort(env.ESP_PORT);
const erase = (env.ESP_ERASE ?? '1') !== '0';
const flashBootstrapArgs = [
  '-m',
  'esptool',
  '--chip',
  'esp32s3',
  '--port',
  port,
  'write_flash',
  '0x0',
  bootstrapBin,
];
const flashNvsArgs = [
  '-m',
  'esptool',
  '--chip',
  'esp32s3',
  '--port',
  port,
  'write_flash',
  '0x9000',
  nvsBinPath,
];

console.error(`[flash-configured] SSID=${config.wifiSsid}`);
console.error(`[flash-configured] collector=${config.collectorHost}:${config.collectorPort}`);
console.error(`[flash-configured] deviceName=${config.deviceName}`);
console.error(`[flash-configured] port=${port}`);
console.error(`[flash-configured] generated ${nvsBinPath}`);

if (!existsSync(bootstrapBin)) {
  throw new Error(`missing ${bootstrapBin}; build dist/bootstrap first`);
}

if (dryRun) {
  console.error(`[flash-configured] dry run; not flashing`);
  console.error(`${python} -m esptool --chip esp32s3 --port ${port} flash_id`);
  if (erase) console.error(`${python} -m esptool --chip esp32s3 --port ${port} erase_flash`);
  console.error(`${python} ${flashBootstrapArgs.join(' ')}`);
  console.error(`${python} ${flashNvsArgs.join(' ')}`);
  process.exit(0);
}

run(python, ['-m', 'esptool', '--chip', 'esp32s3', '--port', port, 'flash_id']);
if (erase) run(python, ['-m', 'esptool', '--chip', 'esp32s3', '--port', port, 'erase_flash']);
run(python, flashBootstrapArgs);
run(python, flashNvsArgs);
run(python, ['-m', 'esptool', '--chip', 'esp32s3', '--port', port, 'read_mac']);

function readEnv(path) {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const parsed = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function required(source, key) {
  const value = source[key];
  if (!value) throw new Error(`missing ${key} in .env`);
  return value;
}

function numberEnv(source, key, fallback, min, max) {
  const raw = source[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function validateConfig(config) {
  if (Buffer.byteLength(config.wifiSsid) < 1 || Buffer.byteLength(config.wifiSsid) > 32) {
    throw new Error('RF_SENSE_WIFI_SSID must be 1-32 bytes');
  }
  const passLen = Buffer.byteLength(config.wifiPassword);
  if (passLen !== 0 && (passLen < 8 || passLen > 63)) {
    throw new Error('RF_SENSE_WIFI_PASSWORD must be empty or 8-63 bytes');
  }
  if (Buffer.byteLength(config.collectorHost) < 1 || Buffer.byteLength(config.collectorHost) > 63) {
    throw new Error('RF_SENSE_COLLECTOR_HOST must resolve to 1-63 bytes');
  }
  if (Buffer.byteLength(config.otaManifestUrl) > 191) {
    throw new Error('RF_SENSE_OTA_MANIFEST_URL must be <=191 bytes');
  }
  if (config.otaManifestUrl && !config.otaManifestUrl.startsWith('https://')) {
    throw new Error('RF_SENSE_OTA_MANIFEST_URL must be empty or https://');
  }
  if (Buffer.byteLength(config.otaChannel) > 15) {
    throw new Error('RF_SENSE_OTA_CHANNEL must be <=15 bytes');
  }
  if (Buffer.byteLength(config.deviceName) > 31) {
    throw new Error('RF_SENSE_DEVICE_NAME must be <=31 bytes');
  }
}

function encodeConfig(config) {
  const bodyLen =
    8 + (33 + 64 + 192 + 16 + 64 + 49 + 32) + (2 + 1 + 2 + 2 + 2 + 4 + 1 + 4 + 1 + 1);
  const body = Buffer.alloc(bodyLen);
  let offset = 0;
  offset = putU32(body, offset, 0x52534346);
  offset = putU16(body, offset, 1);
  offset = putU16(body, offset, 0);
  offset = putString(body, offset, config.wifiSsid, 33);
  offset = putString(body, offset, config.wifiPassword, 64);
  offset = putString(body, offset, config.otaManifestUrl, 192);
  offset = putString(body, offset, config.otaChannel, 16);
  offset = putString(body, offset, config.collectorHost, 64);
  offset = putString(body, offset, '', 49);
  offset = putString(body, offset, config.deviceName, 32);
  offset = putU16(body, offset, config.collectorPort);
  body[offset++] = config.captureMode;
  offset = putU16(body, offset, config.pingPps);
  offset = putU16(body, offset, config.pingPayloadBytes);
  offset = putU16(body, offset, config.pingTimeoutMs);
  offset = putU32(body, offset, config.pingWarmupMs);
  body[offset++] = 0;
  offset = putU32(body, offset, 86400);
  body[offset++] = 0;
  body[offset++] = 1;
  if (offset !== bodyLen) throw new Error(`internal encode size mismatch: ${offset} != ${bodyLen}`);
  const out = Buffer.alloc(bodyLen + 4);
  body.copy(out, 0);
  out.writeUInt32LE(crc32(body), bodyLen);
  return out;
}

function putString(buffer, offset, value, width) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length >= width) throw new Error(`string too long for fixed field (${width})`);
  bytes.copy(buffer, offset);
  return offset + width;
}

function putU16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
  return offset + 2;
}

function putU32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
  return offset + 4;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function resolveCollectorHost(value) {
  if (value && value !== 'auto') return value;
  const found = localIPv4s().find((ip) => !ip.startsWith('169.254.'));
  if (!found) throw new Error('could not auto-detect RF_SENSE_COLLECTOR_HOST');
  return found;
}

function localIPv4s() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function resolvePort(value) {
  if (value && value !== 'auto') return value;
  const dev = '/dev';
  const preferred = readdirSync(dev)
    .filter((name) => name.startsWith('cu.usbmodem') || name.startsWith('tty.usbmodem'))
    .sort();
  if (preferred.length > 0) return `${dev}/${preferred[0]}`;
  throw new Error('could not auto-detect ESP_PORT; set ESP_PORT=/dev/cu.usbmodem...');
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}
