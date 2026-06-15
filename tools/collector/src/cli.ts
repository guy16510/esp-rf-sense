// Entry point for `npm run collector:start`.
//
//   npm run collector:start -- --port 5566 --out data --name run-01 \
//       [--device http://rf-sense-a1b2.local --token <admin>] [--mode controlled]
//
// When --device is given the collector authenticates and tells the device to start capture on
// launch and stop on shutdown, so a recording brackets exactly one capture session. Ctrl-C closes
// the recording cleanly (complete=true). A crash leaves complete=false so the data is flagged.
import { parseArgs, flagNum, flagStr } from './args.js';
import { Collector } from './collector.js';
import { deviceApi, type DeviceApiOptions } from './deviceApi.js';

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const port = flagNum(flags, 'port', 5566);
  const outDir = flagStr(flags, 'out', 'data')!;
  const name = flagStr(flags, 'name', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)!;
  const deviceUrl = flagStr(flags, 'device', undefined, 'RF_SENSE_DEVICE');
  const token = flagStr(flags, 'token', undefined, 'RF_SENSE_TOKEN');

  const device: DeviceApiOptions | null = deviceUrl
    ? { baseUrl: deviceUrl, ...(token ? { token } : {}) }
    : null;

  const collector = new Collector({ port, outDir, name });
  await collector.start();

  if (device) {
    const res = await deviceApi.startCapture(device);
    console.error(`[collector] start capture -> ${res.status} ${JSON.stringify(res.json)}`);
    if (res.status !== 200) {
      console.error('[collector] WARNING: device did not confirm capture start');
    }
  } else {
    console.error('[collector] no --device given; recording whatever arrives on the socket');
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[collector] ${signal} -> stopping`);
    if (device) {
      try {
        const res = await deviceApi.stopCapture(device);
        console.error(`[collector] stop capture -> ${res.status} ${JSON.stringify(res.json)}`);
      } catch (err) {
        console.error(`[collector] stop capture failed: ${(err as Error).message}`);
      }
    }
    await collector.stop(true, `stopped via ${signal}`);
    const s = collector.stats();
    console.error(
      `[collector] summary: ${s.validDatagrams} valid, ${s.invalidDatagrams} invalid, ` +
        `${s.reboots} reboot(s) across ${s.streams.length} stream(s)`,
    );
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Periodic heartbeat so an operator can see the capture is alive.
  setInterval(() => {
    const s = collector.stats();
    const frames = s.streams.reduce((a, st) => a + st.framesReceived, 0);
    console.error(
      `[collector] ${s.validDatagrams} datagrams, ${frames} frames, ${s.invalidDatagrams} invalid`,
    );
  }, 10_000).unref();
}

main().catch((err) => {
  console.error(`[collector] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
