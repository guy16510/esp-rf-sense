import { createSocket } from "node:dgram";
import { DashboardRecorder } from "./dashboard-recorder.js";
import { loadPortableModel } from "./model.js";
import { MultiNodeEngine } from "./multi-node-engine.js";
import { parseDatagram } from "./protocol.js";
import { DashboardServer } from "./web-server.js";

interface Flags {
  udpHost: string;
  udpPort: number;
  httpHost: string;
  httpPort: number;
  intervalMs: number;
  windowFrames: number;
  recordingsDir: string;
  requiredNodes: number;
  motionThreshold?: number;
  modelPath?: string;
  deviceUrls: string[];
}
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const flags = parseFlags(argv);
  const model = flags.modelPath
    ? await loadPortableModel(flags.modelPath)
    : undefined;
  const engine = new MultiNodeEngine({
    windowFrames: flags.windowFrames,
    requiredNodeCount: flags.requiredNodes,
    ...(flags.motionThreshold === undefined
      ? {}
      : { motionThreshold: flags.motionThreshold }),
    ...(model ? { model } : {}),
  });
  const recorder = new DashboardRecorder(flags.recordingsDir);
  const dashboard = new DashboardServer(engine, {
    host: flags.httpHost,
    port: flags.httpPort,
    intervalMs: flags.intervalMs,
    recorder,
    deviceUrls: flags.deviceUrls,
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
    console.error(`[dashboard] UDP error: ${error.message}`),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(flags.udpPort, flags.udpHost, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
  await dashboard.start();
  console.error(`[dashboard] CSI UDP ${flags.udpHost}:${flags.udpPort}`);
  console.error(`[dashboard] web http://${flags.httpHost}:${flags.httpPort}/`);
  console.error(
    `[dashboard] fleet http://${flags.httpHost}:${flags.httpPort}/fleet`,
  );
  console.error(
    `[dashboard] requires ${flags.requiredNodes} fresh physical nodes`,
  );
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[dashboard] ${signal}, stopping`);
    socket.close();
    await recorder.stop(false);
    await dashboard.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}
function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const equal = value.indexOf("=");
    if (equal >= 0) {
      values.set(value.slice(2, equal), value.slice(equal + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(value.slice(2), next);
      index++;
    } else values.set(value.slice(2), "true");
  }
  const threshold = values.get("motion-threshold");
  const modelPath = values.get("model");
  const rawDevices =
    values.get("devices") ??
    values.get("device") ??
    process.env.RF_SENSE_DEVICES ??
    process.env.RF_SENSE_DEVICE ??
    "";
  const deviceUrls = rawDevices
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (/^https?:\/\//u.test(value) ? value : `http://${value}`));
  return {
    udpHost: values.get("udp-host") ?? "0.0.0.0",
    udpPort: numberFlag(values, "udp-port", 5566),
    httpHost: values.get("http-host") ?? "127.0.0.1",
    httpPort: numberFlag(values, "http-port", 8080),
    intervalMs: Math.max(50, numberFlag(values, "interval-ms", 200)),
    windowFrames: Math.max(8, numberFlag(values, "window", 64)),
    recordingsDir: values.get("recordings-dir") ?? "recordings/dashboard",
    requiredNodes: Math.max(1, numberFlag(values, "required-nodes", 4)),
    ...(threshold === undefined ? {} : { motionThreshold: Number(threshold) }),
    ...(modelPath ? { modelPath } : {}),
    deviceUrls,
  };
}
function numberFlag(
  values: Map<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
}
function printHelp(): void {
  console.log(
    `Usage: npm run dashboard:start -- [options]\n\n  --required-nodes N       required physical nodes (default 4)\n  --udp-host HOST          UDP bind host (default 0.0.0.0)\n  --udp-port PORT          UDP port (default 5566)\n  --http-host HOST         HTTP bind host (default 127.0.0.1)\n  --http-port PORT         HTTP port (default 8080)\n  --motion-threshold N     fixed threshold, bypasses baseline learning\n  --model PATH             portable model bundle\n  --devices URLS           comma-separated device control URLs\n  --device URL             one-device compatibility alias\n`,
  );
}
main().catch((error) => {
  console.error(
    `[dashboard] fatal: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
