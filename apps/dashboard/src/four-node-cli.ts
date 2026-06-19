import { createSocket } from 'node:dgram';

import { DashboardRecorder } from './dashboard-recorder.js';
import { loadPortableModel } from './model.js';
import { MultiNodeEngine } from './multi-node-engine.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import { parseDatagram } from './protocol.js';

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const item = process.argv[index]!;
  if (!item.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    values.set(item.slice(2), next);
    index++;
  }
}
const numberFlag = (key: string, fallback: number): number => {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
};

const udpHost = values.get('udp-host') ?? '0.0.0.0';
const udpPort = numberFlag('udp-port', 5566);
const httpHost = values.get('http-host') ?? '127.0.0.1';
const httpPort = numberFlag('http-port', 8080);
const requiredNodeCount = Math.max(1, numberFlag('required-nodes', 4));
const minFrameRateHz = Math.max(0, numberFlag('min-frame-rate', 5));
const recordingsDir = values.get('recordings-dir') ?? 'recordings/dashboard';
const modelPath = values.get('model') ?? values.get('model-path') ?? 'models/dashboard-labels.json';
const model = values.has('model') ? await loadPortableModel(modelPath) : undefined;
const defaultSlotDeviceIds = ['2f4b47f0', 'f6ff4274', 'f6ff95c0', 'f6ff98bc'];
const slotDeviceIds = ['a', 'b', 'c', 'd'].map((slot, index) =>
  (values.get(`slot-${slot}`) ?? defaultSlotDeviceIds[index]!).toLowerCase(),
);
const engine = new MultiNodeEngine({
  requiredNodeCount,
  minFrameRateHz,
  windowFrames: Math.max(8, numberFlag('window', 64)),
  ...(model ? { model } : {}),
});
const recorder = new DashboardRecorder(recordingsDir);
const dashboard = new MultiNodeDashboardServer(engine, {
  host: httpHost,
  port: httpPort,
  intervalMs: Math.max(50, numberFlag('interval-ms', 200)),
  recorder,
  recordingsDir,
  modelPath,
  slotDeviceIds,
  ...(model
    ? {
        model: {
          loaded: true,
          path: modelPath,
          target: model.bundle.target,
          classes: model.bundle.classes,
          trainedAt: null,
          recordings: null,
          windows: null,
          error: null,
        },
      }
    : {}),
});
const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (message) => {
  const result = parseDatagram(message);
  if (!result.ok) {
    engine.recordInvalid();
    return;
  }
  const receivedAt = Date.now();
  engine.accept(result.datagram, receivedAt);
  recorder.write(message, result.datagram, receivedAt);
});
socket.on('error', (error) => console.error(`[four-node] UDP error: ${error.message}`));

await new Promise<void>((resolve, reject) => {
  socket.once('error', reject);
  socket.bind(udpPort, udpHost, () => {
    socket.removeListener('error', reject);
    resolve();
  });
});
await dashboard.start();
console.error(`[four-node] UDP ${udpHost}:${udpPort}`);
console.error(`[four-node] dashboard http://${httpHost}:${httpPort}/fleet`);
console.error(`[four-node] readiness requires ${requiredNodeCount} streams`);
console.error(`[four-node] readiness minimum frame rate ${minFrameRateHz.toFixed(1)} Hz`);
console.error(`[four-node] slots A-D ${slotDeviceIds.join(', ')}`);
console.error(
  `[four-node] model ${model ? `loaded ${modelPath}` : `not loaded; train to ${modelPath}`}`,
);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.error(`\n[four-node] ${signal}, stopping`);
  socket.close();
  await recorder.stop(false);
  await dashboard.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
