// Entry for `npm run experiment:start|stop|status`.
//
//   experiment:start -- --host <ip> --experiment occupancy-room-A \
//       --group stationary --room "Room A" --channel 6 --ping-pps 25 \
//       --tx "Asus RT-AX55" --subjects p01 --duration 120 --out data
//   experiment:stop   -- --host <ip>     # abort: tell the device to stop capture
//   experiment:status -- --host <ip>     # device status
//   experiment list-templates
import { apiCall, resolveBaseUrl, type DeviceTarget } from './deviceApi.js';
import { startExperiment, type StartOptions } from './runner.js';
import { listTemplates } from './templates.js';

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(a.slice(2), next);
          i++;
        } else flags.set(a.slice(2), 'true');
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}

function requireTarget(flags: Map<string, string>): DeviceTarget {
  const host = flags.get('host') ?? process.env.RF_SENSE_DEVICE;
  if (!host) {
    console.error('error: --host <hostname-or-ip> required (or RF_SENSE_DEVICE)');
    process.exit(2);
  }
  return { baseUrl: resolveBaseUrl(host) };
}

function num(flags: Map<string, string>, key: string, fallback: number): number {
  const v = flags.get(key);
  return v === undefined ? fallback : Number(v);
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (cmd === 'list-templates') {
    console.log('available experiment group templates:\n');
    console.log(listTemplates());
    return;
  }

  if (cmd === 'start') {
    const target = requireTarget(flags);
    const subjects = (flags.get('subjects') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const opts: StartOptions = {
      device: target,
      experimentId: flags.get('experiment') ?? 'experiment',
      group: flags.get('group') ?? 'empty-baseline',
      room: flags.get('room') ?? 'unspecified',
      durationS: num(flags, 'duration', 60),
      collectorPort: num(flags, 'port', 5566),
      outDir: flags.get('out') ?? 'data',
      channel: num(flags, 'channel', 6),
      pingPps: num(flags, 'ping-pps', 25),
      txDescription: flags.get('tx') ?? 'unspecified transmitter',
      subjectIds: subjects,
      ...(flags.get('label') ? { label: flags.get('label')! } : {}),
      ...(flags.get('notes') ? { notes: flags.get('notes')! } : {}),
      ...(flags.get('day') ? { day: flags.get('day')! } : {}),
    };
    await startExperiment(opts);
    return;
  }

  if (cmd === 'stop') {
    const target = requireTarget(flags);
    const res = await apiCall(target, 'POST', '/capture/stop');
    console.log(`stop capture: HTTP ${res.status}`);
    console.log(JSON.stringify(res.json, null, 2));
    process.exit(res.status === 200 ? 0 : 1);
  }

  if (cmd === 'status') {
    const target = requireTarget(flags);
    const res = await apiCall(target, 'GET', '/status');
    console.log(`status: HTTP ${res.status}`);
    console.log(JSON.stringify(res.json, null, 2));
    process.exit(res.status === 200 ? 0 : 1);
  }

  console.error('usage: experiment <start|stop|status|list-templates> [flags]');
  process.exit(2);
}

main().catch((err) => {
  console.error(`experiment: fatal: ${(err as Error).message}`);
  process.exit(1);
});
