import { createSocket } from 'node:dgram';

import { DashboardServer } from './web-server.js';
import { RealtimeEngine } from './engine.js';
import { LabServer } from './lab-server.js';
import { loadPortableModel } from './model.js';
import { MultiNodeEngine } from './multi-node-engine.js';
import { parseDatagram } from './protocol.js';

interface Flags {
  udpHost: string;
  udpPort: number;
  httpHost: string;
  httpPort: number;
  labPort: number;
  intervalMs: number;
  windowFrames: number;
  requiredNodes: number;
  source: 'real';
  motionThreshold?: number;
  modelPath?: string;
  deviceUrl?: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const flags = parseFlags(argv);
  const model = flags.modelPath ? await loadPortableModel(flags.modelPath) : undefined;
  const engine = new RealtimeEngine({
    windowFrames: flags.windowFrames,
    ...(flags.motionThreshold === undefined ? {} : { motionThreshold: flags.motionThreshold }),
    ...(model ? { model } : {}),
  });
  const multiEngine = new MultiNodeEngine(
    flags.windowFrames,
    flags.motionThreshold,
    flags.requiredNodes,
  );
  const dashboard = new DashboardServer(engine, {
    host: flags.httpHost,
    port: flags.httpPort,
    intervalMs: flags.intervalMs,
    ...(flags.deviceUrl ? { deviceUrl: flags.deviceUrl } : {}),
  });
  const lab = new LabServer(multiEngine, flags.httpHost, flags.labPort);
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (message) => {
    const result = parseDatagram(message);
    if (!result.ok) {
      engine.recordInvalid();
      multiEngine.recordInvalid();
      return;
    }
    const receivedAt = Date.now();
    engine.accept(result.datagram, receivedAt);
    multiEngine.accept(result.datagram, receivedAt);
  });
  socket.on('error', (error) => console.error(`[dashboard] UDP error: ${error.message}`));

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(flags.udpPort, flags.udpHost, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
  await Promise.all([dashboard.start(), lab.start()]);
  console.error('[dashboard] source REAL only; simulation fallback is disabled');
  console.error(`[dashboard] CSI UDP ${flags.udpHost}:${flags.udpPort}`);
  console.error(`[dashboard] web http://${flags.httpHost}:${flags.httpPort}/`);
  console.error(`[dashboard] nodes http://${flags.httpHost}:${flags.labPort}/api/nodes`);
  console.error(`[dashboard] readiness http://${flags.httpHost}:${flags.labPort}/api/lab/readiness`);
  console.error(`[dashboard] capture requires ${flags.requiredNodes} fresh physical nodes`);
  console.error(
    `[dashboard] mode ${model ? `portable model (${model.bundle.target})` : 'heuristic'}`,
  );
  if (flags.deviceUrl) console.error(`[dashboard] device logs ${flags.deviceUrl}/api/v1/logs`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[dashboard] ${signal}, stopping`);
    socket.close();
    await Promise.all([dashboard.stop(), lab.stop()]);
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
  const source = values.get('source') ?? process.env.RF_SENSE_SOURCE ?? 'real';
  if (source !== 'real') {
    throw new Error(
      `hardware dashboard requires source=real; received ${source}. Simulation must use a separate explicit command.`,
    );
  }
  const threshold = values.get('motion-threshold');
  const modelPath = values.get('model');
  const deviceUrl = values.get('device') ?? process.env.RF_SENSE_DEVICE;
  return {
    udpHost: values.get('udp-host') ?? '0.0.0.0',
    udpPort: numberFlag(values, 'udp-port', 5566),
    httpHost: values.get('http-host') ?? '127.0.0.1',
    httpPort: numberFlag(values, 'http-port', 8080),
    labPort: numberFlag(values, 'lab-port', 8081),
    intervalMs: Math.max(50, numberFlag(values, 'interval-ms', 200)),
    windowFrames: Math.max(8, numberFlag(values, 'window', 64)),
    requiredNodes: Math.max(1, numberFlag(values, 'required-nodes', 4)),
    source: 'real',
    ...(threshold === undefined ? {} : { motionThreshold: Number(threshold) }),
    ...(modelPath === undefined ? {} : { modelPath }),
    ...(deviceUrl === undefined ? {} : { deviceUrl }),
  };
}

function numberFlag(values: Map<string, string>, key: string, fallback: number): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: npm run dashboard:start -- [options]

Options:
  --source real            Required hardware source; no automatic simulation fallback
  --udp-host HOST          UDP bind host (default 0.0.0.0)
  --udp-port PORT          UDP port for CSI datagrams (default 5566)
  --http-host HOST         HTTP bind host (default 127.0.0.1)
  --http-port PORT         HTTP dashboard port (default 8080)
  --lab-port PORT          Four-node readiness API port (default 8081)
  --required-nodes N       Physical nodes required for capture readiness (default 4)
  --interval-ms MS         Push interval in milliseconds (default 200)
  --window FRAMES          Frames per inference window (default 64)
  --motion-threshold N     Override heuristic motion threshold
  --model PATH             Portable model bundle
  --device URL             ESP32 control API base URL for live logs (or RF_SENSE_DEVICE)
  -h, --help               Show this help
`);
}

main().catch((error) => {
  console.error(`[dashboard] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
