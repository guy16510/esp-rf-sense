import { apiCall, requireHost } from './apiClient.js';
import { parseArgs } from './args.js';

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`provide --${name} <value>`);
  return value;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const target = requireHost(flags);
  const collectorHost = requiredFlag(flags, 'collector-host');
  const collectorPort = Number(flags.get('collector-port') ?? '5566');
  if (!Number.isInteger(collectorPort) || collectorPort < 1 || collectorPort > 65535) {
    throw new Error('--collector-port must be an integer from 1 to 65535');
  }

  const save = await apiCall(target, 'POST', '/config', { collectorHost, collectorPort });
  if (save.status !== 200) throw new Error(`config save failed with HTTP ${save.status}`);

  const verify = await apiCall(target, 'GET', '/config');
  const config = verify.json as { collectorHost?: string; collectorPort?: number };
  if (verify.status !== 200 || config.collectorHost !== collectorHost || Number(config.collectorPort) !== collectorPort) {
    throw new Error('config verification failed; device was not rebooted');
  }

  console.log(`saved collector target ${collectorHost}:${collectorPort}`);
  const reboot = await apiCall(target, 'POST', '/reboot');
  if (reboot.status !== 202) throw new Error(`reboot request failed with HTTP ${reboot.status}`);
  console.log('device is rebooting and will stream to the new collector target');
}

main().catch((error) => {
  console.error(`configure: fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
