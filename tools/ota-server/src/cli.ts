// Entry point for `npm run ota-server:start`.
//
// Environment:
//   RF_SENSE_OTA_ROOT   directory with manifest/ and firmware/ (default dist/ota)
//   RF_SENSE_OTA_PORT   listen port (default 8443)
//   RF_SENSE_OTA_HOST   bind address (default 0.0.0.0)
//   RF_SENSE_TLS_CERT   path to the server certificate (PEM)
//   RF_SENSE_TLS_KEY    path to the server private key (PEM)
//   RF_SENSE_OTA_ALLOW_HTTP=1  permit plaintext HTTP when no TLS material is given (DEV ONLY)
//
// The server validates the OTA root before binding and refuses to start if any advertised manifest
// is inconsistent with the firmware on disk.
import { loadConfig } from './config.js';
import { createOtaServer } from './server.js';
import { hasErrors, validateOtaRoot } from './validate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.error(`[ota-server] validating OTA root: ${config.root}`);
  const validation = await validateOtaRoot(config.root);

  for (const r of validation) {
    if (!r.present) {
      console.error(`[ota-server]   ${r.channel}: (no manifest)`);
      continue;
    }
    console.error(`[ota-server]   ${r.channel}: version ${r.manifest?.version ?? '??'}`);
    for (const issue of r.issues) {
      console.error(`[ota-server]     ${issue.level.toUpperCase()}: ${issue.message}`);
    }
  }

  if (hasErrors(validation)) {
    console.error('[ota-server] FATAL: validation errors above; refusing to serve.');
    process.exit(1);
  }

  if (!config.tls) {
    if (!config.allowHttp) {
      console.error(
        '[ota-server] FATAL: no TLS cert/key (RF_SENSE_TLS_CERT/KEY) and RF_SENSE_OTA_ALLOW_HTTP != 1.',
      );
      console.error(
        '[ota-server] The device requires HTTPS; refusing to start a plaintext server in prod.',
      );
      process.exit(1);
    }
    console.error(
      '[ota-server] WARNING: serving plaintext HTTP (dev mode). Devices reject this in prod.',
    );
  }

  const server = createOtaServer(config, validation);
  server.listen(config.port, config.host, () => {
    const scheme = config.tls ? 'https' : 'http';
    console.error(`[ota-server] listening on ${scheme}://${config.host}:${config.port}`);
  });

  const shutdown = (sig: string) => {
    console.error(`\n[ota-server] ${sig} -> closing`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[ota-server] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
