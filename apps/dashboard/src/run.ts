import { createSocket } from 'node:dgram';

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

const udpHost = args.get('udp-host') ?? '0.0.0.0';
const udpPort = number('udp-port', 5566);
const httpHost = args.get('http-host') ?? '127.0.0.1';
const httpPort = number('http-port', 8080);
const intervalMs = Math.max(50, number('interval-ms', 200));
const windowFrames = Math.max(8, number('window', 64));
const threshold = args.has('motion-threshold') ? number('motion-threshold', 0) : undefined;
const engine = new NodeEngine(windowFrames, threshold);
const dashboard = new NodeDashboardServer(engine, httpHost, httpPort, intervalMs);
const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (message) => {
  const result = parseDatagram(message);
  if (result.ok) engine.accept(result.datagram, Date.now());
  else engine.recordInvalid();
});
socket.on('error', (error) => console.error(`[dashboard] UDP error: ${error.message}`));
socket.bind(udpPort, udpHost, async () => {
  await dashboard.start();
  console.error(`[dashboard] CSI UDP ${udpHost}:${udpPort}`);
  console.error(`[dashboard] web http://${httpHost}:${httpPort}/`);
});
