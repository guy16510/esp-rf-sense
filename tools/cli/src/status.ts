// Prints a device's status and health.
//
//   npm run device:status -- --host rf-sense-a1b2.local [--token <admin>] [--health]
import { apiCall, requireHost } from './apiClient.js';
import { parseArgs } from './args.js';

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const target = requireHost(flags);

  const status = await apiCall(target, 'GET', '/status');
  console.log(`status: HTTP ${status.status}`);
  console.log(JSON.stringify(status.json, null, 2));

  if (flags.has('health')) {
    const health = await apiCall(target, 'GET', '/health');
    console.log(`\nhealth: HTTP ${health.status}`);
    console.log(JSON.stringify(health.json, null, 2));
  }

  process.exit(status.status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error(`status: fatal: ${(err as Error).message}`);
  process.exit(1);
});
