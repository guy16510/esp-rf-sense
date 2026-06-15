// Discovers RF-Sense devices on the LAN via mDNS (the device advertises _http._tcp with TXT
// metadata in firmware/components/mdns_service). Pure-JS, no native bonjour dependency.
//
//   npm run device:discover -- [--timeout 4000]
//
// mDNS can be blocked by network policy; this is a convenience, never the only path. Every other
// command accepts --host <ip> so you can always reach a device by address.
import { Bonjour, type Service } from 'bonjour-service';

import { flagNum, parseArgs } from './args.js';

interface Found {
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const timeoutMs = flagNum(flags, 'timeout', 4000);

  const bonjour = new Bonjour();
  const found = new Map<string, Found>();

  const browser = bonjour.find({ type: 'http' }, (service: Service) => {
    const name = service.name ?? '';
    const txt = (service.txt ?? {}) as Record<string, string>;
    // The device advertises an "id" TXT and a name like RF-Sense-XXXX; filter to ours.
    const isOurs = /^rf-sense/i.test(name) || typeof txt.id === 'string';
    if (!isOurs) return;
    found.set(name || service.host || String(service.port), {
      name,
      host: service.host ?? '',
      port: service.port ?? 80,
      addresses: service.addresses ?? [],
      txt,
    });
  });

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  browser.stop();
  bonjour.destroy();

  const devices = [...found.values()];
  if (devices.length === 0) {
    console.error('no devices found via mDNS within the timeout.');
    console.error('tip: reach a device directly with --host <ip> on any command.');
    process.exit(1);
  }

  for (const d of devices) {
    const addr = d.addresses[0] ?? d.host;
    console.log(`${d.name}`);
    console.log(`  url:     http://${addr}:${d.port}`);
    console.log(`  host:    ${d.host}`);
    if (d.addresses.length) console.log(`  addrs:   ${d.addresses.join(', ')}`);
    const meta = Object.entries(d.txt)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    if (meta) console.log(`  txt:     ${meta}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(`discover: fatal: ${(err as Error).message}`);
  process.exit(1);
});
