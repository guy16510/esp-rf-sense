// Drives OTA from an operator workstation against one device.
//
//   npm run device:ota:check -- --host rf-sense-a1b2.local --token <admin>
//   npm run device:ota:apply -- --host 192.168.1.50      --token <admin>
//
// `check` downloads + validates the manifest on the device and reports whether a newer image is
// available. `apply` only proceeds if a validated update is pending; the device verifies SHA-256
// against the embedded manifest before switching slots and rolls back automatically on a bad boot.
import { apiCall, requireHost } from './apiClient.js';
import { parseArgs } from './args.js';

function printJson(label: string, status: number, json: unknown): void {
  console.log(`${label}: HTTP ${status}`);
  console.log(JSON.stringify(json, null, 2));
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const sub = positionals[0];
  const target = requireHost(flags);

  if (sub === 'check') {
    const res = await apiCall(target, 'POST', '/ota/check');
    printJson('ota check', res.status, res.json);
    const available = (res.json as { updateAvailable?: boolean })?.updateAvailable === true;
    process.exit(available ? 0 : 3); // exit 3 = no update available (scriptable)
  }

  if (sub === 'apply') {
    const check = await apiCall(target, 'POST', '/ota/check');
    const available = (check.json as { updateAvailable?: boolean })?.updateAvailable === true;
    if (!available) {
      printJson('ota check', check.status, check.json);
      console.error('apply aborted: no validated update available.');
      process.exit(3);
    }
    const res = await apiCall(target, 'POST', '/ota/apply');
    printJson('ota apply', res.status, res.json);
    console.error(
      'device will verify SHA-256, switch slots, reboot, then self-validate or roll back.',
    );
    process.exit(res.status === 202 ? 0 : 1);
  }

  console.error('usage: ota <check|apply> --host <hostname-or-ip> [--token <admin>]');
  process.exit(2);
}

main().catch((err) => {
  console.error(`ota: fatal: ${(err as Error).message}`);
  process.exit(1);
});
