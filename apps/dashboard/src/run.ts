import { createSocket } from 'node:dgram';

import { LabServer } from './lab-server.js';
import { MultiNodeEngine } from './multi-node-engine.js';
import { NodeEngine } from './node-engine.js';
import { NodeDashboardServer } from './node-server.js';
import { parseDatagram } from './protocol.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--') && value && !value.startsWith('--')) {
    args.set(key.slice(2), value);
    index++;
  }
}
const number = (key: string, fallback: number) => {
  const value = Number(args.get(key) ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
};

const source = args.get('source') ?? process.env.RF_SENSE_SOURCE ?? 'real';
if (source !== 'real') {
  throw new Error(
    `dashboard hardware mode requires --source real; received ${source}. Simulation is never an automatic fallback.`,
  );
}

const udpHost = args.get('udp-host') ?? '0.0.0.0';
const udpPort = number('udp-port', 5566);
const httpHost = args.get('http-host') ?? '127.0.0.1';
const httpPort = number('http-port', 8080);
const labPort = number('lab-port', 8081);
const intervalMs = Math.max(50, number('interval-ms', 200));
const windowFrames = Math.max(8, number('window', 64));
const requiredNodes = Math.max(1, number('required-nodes', 4));
const threshold = args.has('motion-threshold') ? number('motion-threshold', 0) : undefined;
const legacyEngine = new NodeEngine(windowFrames, threshold);
const multiEngine = new MultiNodeEngine(windowFrames, threshold, requiredNodes);
const dashboard = new NodeDashboardServer(legacyEngine, httpHost, httpPort, intervalMs);
const lab = new LabServer(multiEngine, httpHost, labPort);
const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (message) => {
  const result = parseDatagram(message);
  if (result.ok) {
    const receivedAt = Date.now();
    legacyEngine.accept(result.datagram, receivedAt);
    multiEngine.accept(result.datagram, receivedAt);
  } else {
    legacyEngine.recordInvalid();
    multiEngine.recordInvalid();
  }
});
socket.on('error', (error) => console.error(`[dashboard] UDP error: ${error.message}`));
socket.bind(udpPort, udpHost, async () => {
  await Promise.all([dashboard.start(), lab.start()]);
  console.error(`[dashboard] source REAL only, no simulation fallback`);
  console.error(`[dashboard] CSI UDP ${udpHost}:${udpPort}`);
  console.error(`[dashboard] web http://${httpHost}:${httpPort}/`);
  console.error(`[dashboard] four-node API http://${httpHost}:${labPort}/api/lab/state`);
  console.error(`[dashboard] capture requires ${requiredNodes} fresh physical nodes`);
});
