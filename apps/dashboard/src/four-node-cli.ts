import { createSocket } from 'node:dgram';
import { access } from 'node:fs/promises';

import { CONTINUOUS_XY_MODEL_FORMAT, loadContinuousXYModel, type ContinuousXYModel } from './continuous-xy-model.js';
import { DashboardRecorder } from './dashboard-recorder.js';
import { loadPortableModel } from './model.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import { JointPositionEngine } from './joint-position-engine.js';
import type { ReceiverSourceMapping } from './live-xy-runtime.js';
import { parseDatagram } from './protocol.js';
import { decodeCsiFrameV2 } from './protocol-v2.js';

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
const loadedModel = values.has('no-model')
  ? undefined
  : await loadDashboardCliModelIfPresent(modelPath, values.has('model') || values.has('model-path'));
const defaultSlotDeviceIds = ['2f4b47f0', '2f4b5390', '2f4b735c', '2f77883c'];
const slotDeviceIds = ['a', 'b', 'c', 'd'].map((slot, index) =>
  (
    values.get(`slot-${slot}`) ??
    process.env[`RF_SENSE_SLOT_${slot.toUpperCase()}`] ??
    defaultSlotDeviceIds[index]!
  ).toLowerCase(),
);
const continuousModel = loadedModel?.kind === 'continuous-xy' ? loadedModel.model : undefined;
const portableModel = loadedModel?.kind === 'portable' ? loadedModel.model : undefined;
const engine = new JointPositionEngine(
  {
    requiredNodeCount,
    minFrameRateHz,
    windowFrames: Math.max(8, numberFlag('window', 64)),
    ...(portableModel ? { model: portableModel } : {}),
  },
  continuousModel?.room.widthMeters ?? 4,
  continuousModel?.room.heightMeters ?? 4,
);
const receiverMappings: ReceiverSourceMapping[] = ['a', 'b', 'c', 'd'].map((slot, index) => ({
  slot: slot.toUpperCase() as ReceiverSourceMapping['slot'],
  deviceId: slotDeviceIds[index]!,
  ...(values.get(`slot-${slot}-address`) ? { address: values.get(`slot-${slot}-address`)! } : {}),
  ...(values.get(`slot-${slot}-port`) ? { port: numberFlag(`slot-${slot}-port`, 0) } : {}),
}));
const recorder = new DashboardRecorder(recordingsDir);
const dashboard = new MultiNodeDashboardServer(engine, {
  host: httpHost,
  port: httpPort,
  intervalMs: Math.max(50, numberFlag('interval-ms', 200)),
  recorder,
  recordingsDir,
  modelPath,
  slotDeviceIds,
  receiverMappings,
  ...(continuousModel
    ? {
        continuousXYModel: continuousModel,
        continuousXYWindowPackets: Math.max(4, numberFlag('xy-window-packets', 24)),
      }
    : {}),
  ...(loadedModel
    ? {
        model: {
          loaded: true,
          path: modelPath,
          target: loadedModel.kind === 'continuous-xy' ? 'continuous-xy' : loadedModel.model.bundle.target === 'position' ? 'coarse-zones' : loadedModel.model.bundle.target,
          classes: loadedModel.kind === 'continuous-xy' ? ['continuous-xy'] : loadedModel.model.bundle.classes,
          trainedAt: null,
          recordings: loadedModel.kind === 'continuous-xy' ? loadedModel.model.examples.length : null,
          windows: null,
          error: null,
          ...(loadedModel.kind === 'continuous-xy'
            ? { validatedContinuousXY: loadedModel.model.validation.validatedContinuousXY }
            : {}),
        },
      }
    : {}),
});
const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (message, remote) => {
  if (isProtocolV2(message)) {
    const receivedAt = Date.now();
    const predictions = dashboard.acceptProtocolV2Datagram(
      message,
      { address: remote.address, port: remote.port },
      receivedAt,
    );
    try {
      recorder.writeProtocolV2(message, decodeCsiFrameV2(message), { address: remote.address, port: remote.port }, receivedAt);
    } catch {
      engine.recordInvalid();
    }
    if (predictions.length === 0) return;
    return;
  }
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
  `[four-node] model ${loadedModel ? `loaded ${modelPath} (${loadedModel.kind})` : `not loaded; train to ${modelPath}`}`,
);
if (continuousModel) {
  console.error(
    `[four-node] continuous XY source mappings ${receiverMappings
      .map((item) => `${item.slot}:${item.address ?? '*'}:${item.port ?? '*'}`)
      .join(', ')}`,
  );
}

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

type DashboardCliModel =
  | { kind: 'continuous-xy'; model: ContinuousXYModel }
  | { kind: 'portable'; model: Awaited<ReturnType<typeof loadPortableModel>> };

async function loadDashboardCliModel(path: string): Promise<DashboardCliModel> {
  const { readFile } = await import('node:fs/promises');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { format?: string };
  if (parsed.format === CONTINUOUS_XY_MODEL_FORMAT) {
    return { kind: 'continuous-xy', model: await loadContinuousXYModel(path) };
  }
  return { kind: 'portable', model: await loadPortableModel(path) };
}

async function loadDashboardCliModelIfPresent(
  path: string,
  required: boolean,
): Promise<DashboardCliModel | undefined> {
  try {
    await access(path);
  } catch (error) {
    if (required) throw error;
    return undefined;
  }
  return loadDashboardCliModel(path);
}

function isProtocolV2(message: Buffer): boolean {
  if (message.length < 5) return false;
  if (message.subarray(0, 4).toString('ascii') !== 'RFV2') return false;
  try {
    decodeCsiFrameV2(message);
    return true;
  } catch {
    return false;
  }
}
