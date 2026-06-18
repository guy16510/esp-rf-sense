import { createSocket } from "node:dgram";

import { DashboardRecorder } from "./dashboard-recorder.js";
import { MultiNodeEngine } from "./multi-node-engine.js";
import { MultiNodeDashboardServer } from "./multi-node-web-server.js";
import { parseDatagram } from "./protocol.js";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const item = process.argv[index]!;
  if (!item.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    values.set(item.slice(2), next);
    index++;
  }
}
const numberFlag = (key: string, fallback: number): number => {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
};

const udpHost = values.get("udp-host") ?? "0.0.0.0";
const udpPort = numberFlag("udp-port", 5566);
const httpHost = values.get("http-host") ?? "127.0.0.1";
const httpPort = numberFlag("http-port", 8080);
const requiredNodeCount = Math.max(1, numberFlag("required-nodes", 4));
const engine = new MultiNodeEngine({
  requiredNodeCount,
  windowFrames: Math.max(8, numberFlag("window", 64)),
});
const recorder = new DashboardRecorder(
  values.get("recordings-dir") ?? "recordings/dashboard",
);
const dashboard = new MultiNodeDashboardServer(engine, {
  host: httpHost,
  port: httpPort,
  intervalMs: Math.max(50, numberFlag("interval-ms", 200)),
  recorder,
});
const socket = createSocket({ type: "udp4", reuseAddr: true });

socket.on("message", (message) => {
  const result = parseDatagram(message);
  if (!result.ok) {
    engine.recordInvalid();
    return;
  }
  const receivedAt = Date.now();
  engine.accept(result.datagram, receivedAt);
  recorder.write(message, result.datagram, receivedAt);
});
socket.on("error", (error) =>
  console.error(`[four-node] UDP error: ${error.message}`),
);

await new Promise<void>((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(udpPort, udpHost, () => {
    socket.removeListener("error", reject);
    resolve();
  });
});
await dashboard.start();
console.error(`[four-node] UDP ${udpHost}:${udpPort}`);
console.error(`[four-node] dashboard http://${httpHost}:${httpPort}/fleet`);
console.error(`[four-node] readiness requires ${requiredNodeCount} streams`);

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
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
