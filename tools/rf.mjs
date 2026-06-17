#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, platform } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const flags = parseArgs(process.argv.slice(2));
const httpPort = numberFlag(flags, 'http-port', 8080);
const udpPort = numberFlag(flags, 'udp-port', 5566);
const lan = selectLanAddress(networkInterfaces());
let child;

main().catch((error) => {
  console.error(`\n[rf] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  assertNode22();
  ensureDependencies();

  console.error(`[rf] collector interface ${lan.name} ${lan.address}`);
  console.error(`[rf] CSI UDP port ${udpPort}`);

  if (flags.has('flash')) {
    console.error('[rf] building firmware and flashing configured ESP32-S3');
    run('npm', ['run', 'firmware:bundle']);
    run('npm', ['run', 'flash']);
    console.error('[rf] flash complete; waiting for Wi-Fi startup');
    await sleep(4000);
  }

  const discovered = await resolveDevice(flags.get('device'));
  if (discovered) {
    console.error(`[rf] device ${discovered}`);
    await ensureCollectorConfiguration(discovered, lan.address, udpPort);
  } else {
    console.error('[rf] no control API discovered; dashboard will still listen for CSI');
    console.error('[rf] for first-time setup join RF-Sense-XXXX and open http://192.168.4.1');
    console.error('[rf] otherwise pass --device http://<device-ip>');
  }

  const dashboardArgs = [
    'run',
    'dashboard:start',
    '--',
    '--http-host',
    '0.0.0.0',
    '--http-port',
    String(httpPort),
    '--udp-host',
    '0.0.0.0',
    '--udp-port',
    String(udpPort),
  ];
  if (discovered) dashboardArgs.push('--device', discovered);

  child = spawn('npm', dashboardArgs, { cwd: root, env: process.env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) console.error(`[rf] dashboard stopped by ${signal}`);
    process.exit(code ?? 0);
  });

  const localUrl = `http://127.0.0.1:${httpPort}/`;
  const phoneUrl = `http://${lan.address}:${httpPort}/`;
  console.error(`[rf] dashboard ${localUrl}`);
  console.error(`[rf] phone ${phoneUrl}`);
  if (!flags.has('no-open')) setTimeout(() => openBrowser(localUrl), 700).unref();

  const stop = (signal) => {
    if (!child || child.killed) return;
    console.error(`\n[rf] ${signal}; stopping dashboard`);
    child.kill('SIGTERM');
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(key, next);
      index++;
    } else {
      values.set(key, 'true');
    }
  }
  return {
    get: (key) => values.get(key),
    has: (key) => values.has(key),
  };
}

function numberFlag(values, key, fallback) {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`--${key} must be a valid port`);
  }
  return value;
}

function assertNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) throw new Error(`Node.js 22 is required; found ${process.version}`);
}

function ensureDependencies() {
  const tsx = resolve(root, 'node_modules', '.bin', platform() === 'win32' ? 'tsx.cmd' : 'tsx');
  if (existsSync(tsx)) return;
  console.error('[rf] installing pinned Node dependencies');
  run('npm', ['ci']);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

async function resolveDevice(explicit) {
  const candidate = explicit || process.env.RF_SENSE_DEVICE;
  if (candidate) return normalizeDevice(candidate);

  const result = spawnSync('npm', ['run', 'device:discover'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 5000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/https?:\/\/[^\s]+|rf-sense-[a-z0-9-]+\.local/iu);
  if (!match) return null;
  return normalizeDevice(match[0]);
}

function normalizeDevice(value) {
  const trimmed = String(value).trim().replace(/\/$/u, '');
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function ensureCollectorConfiguration(device, host, port) {
  const status = await fetchJson(new URL('/api/v1/status', device));
  console.error(`[rf] firmware ${status.firmware?.version || 'unknown'}, capture ${status.capture?.active ? 'active' : 'idle'}`);

  const configUrl = new URL('/api/v1/config', device);
  const config = await fetchJson(configUrl);
  if (config.collectorHost === host && Number(config.collectorPort) === port) return;

  console.error(`[rf] correcting collector ${config.collectorHost || 'unset'}:${config.collectorPort || 'unset'} -> ${host}:${port}`);
  await fetchJson(configUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collectorHost: host, collectorPort: port }),
  });
  await fetchJson(new URL('/api/v1/reboot', device), { method: 'POST' });
  console.error('[rf] device rebooting to apply collector configuration');
  await waitForDevice(device, 30000);
}

async function waitForDevice(device, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    try {
      await fetchJson(new URL('/api/v1/status', device));
      return;
    } catch {
      // Reboot in progress.
    }
  }
  throw new Error(`device did not return within ${Math.round(timeoutMs / 1000)} seconds`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2500) });
  const text = await response.text();
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url.pathname} returned invalid JSON`);
  }
  if (!response.ok) throw new Error(value.error || `${url.pathname} returned HTTP ${response.status}`);
  return value;
}

function selectLanAddress(interfaces) {
  const blocked = /(docker|podman|vbox|vmnet|utun|tun|tap|tailscale|bridge|loopback)/iu;
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (blocked.test(name)) continue;
    for (const value of addresses || []) {
      if (value.family !== 'IPv4' || value.internal || value.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/^(en|eth|wlan|wi-fi)/iu.test(name)) score += 10;
      if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./u.test(value.address)) score += 5;
      candidates.push({ name, address: value.address, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  if (!candidates.length) throw new Error('no usable LAN IPv4 address found');
  return candidates[0];
}

function openBrowser(url) {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' });
  opener.unref();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
