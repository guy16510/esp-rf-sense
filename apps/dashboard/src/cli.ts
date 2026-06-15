import { createSocket } from 'node:dgram';

import { DashboardServer } from './web-server.js';
import { RealtimeEngine } from './engine.js';
import { loadPortableModel } from './model.js';
import { parseDatagram } from './protocol.js';

interface Flags {
  udpHost: string;
  udpPort: number;
  httpHost: string;
  httpPort: number;
  intervalMs: number;
  windowFrames: number;
  motionThreshold?: number;
  modelPath?: string;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const model = flags.modelPath ? await loadPortableModel(flags.modelPath) : undefined;
  const engine = new RealtimeEngine({
    windowFrames: flags.windowFrames,
    ...(flags.motionThreshold === undefined ? {} : { motionThreshold: flags.motionThreshold }),
    ...(model ? { model } : {}),
  });
  const dashboard = new DashboardServer(engine, {
    host: flags.httpHost,
    port: flags.httpPort,
    intervalMs: flags.intervalMs,
  });
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (message) => {
    const result = parseDatagram(message);
    if (!result.ok) {
      engine.recordInvalid();
      return;
    }
    engine.accept(result.datagram, Date.now());
  });
  socket.on('error', (error) => console.error(`[dashboard] UDP error: ${error.message}`));

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(flags.udpPort, flags.udpHost, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
  await dashboard.start();
  console.error(`[dashboard] CSI UDP ${flags.udpHost}:${flags.udpPort}`);
  console.error(`[dashboard] web http://${flags.httpHost}:${flags.httpPort}/`);
  console.error(`[dashboard] mode ${model ? `portable model (${model.bundle.target})` : 'heuristic'}`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[dashboard] ${signal}, stopping`);
    socket.close();
    await dashboard.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith('--')) continue;
    const equal = value.indexOf('=');
    if (equal >= 0) {
      values.set(value.slice(2, equal), value.slice(equal + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(value.slice(2), next);
      index++;
    } else {
      values.set(value.slice(2), 'true');
    }
  }
  const threshold = values.get('motion-threshold');
  const modelPath = values.get('model');
  return {
    udpHost: values.get('udp-host') ?? '0.0.0.0',
    udpPort: numberFlag(values, 'udp-port', 5566),
    httpHost: values.get('http-host') ?? '127.0.0.1',
    httpPort: numberFlag(values, 'http-port', 8080),
    intervalMs: Math.max(50, numberFlag(values, 'interval-ms', 200)),
    windowFrames: Math.max(8, numberFlag(values, 'window', 64)),
    ...(threshold === undefined ? {} : { motionThreshold: Number(threshold) }),
    ...(modelPath === undefined ? {} : { modelPath }),
  };
}

function numberFlag(values: Map<string, string>, key: string, fallback: number): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
}

main().catch((error) => {
  console.error(`[dashboard] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
