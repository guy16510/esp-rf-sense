// Environment-driven configuration for the OTA server.
import { readFileSync } from 'node:fs';

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export interface OtaServerConfig {
  root: string; // directory holding manifest/ and firmware/
  port: number;
  host: string;
  tls: TlsMaterial | null; // null => plaintext HTTP (dev only, must be explicitly allowed)
  allowHttp: boolean;
}

function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): OtaServerConfig {
  const root = envStr('RF_SENSE_OTA_ROOT', 'dist/ota');
  const port = Number(envStr('RF_SENSE_OTA_PORT', '8443'));
  const host = envStr('RF_SENSE_OTA_HOST', '0.0.0.0');
  const allowHttp = process.env.RF_SENSE_OTA_ALLOW_HTTP === '1';

  const certPath = process.env.RF_SENSE_TLS_CERT;
  const keyPath = process.env.RF_SENSE_TLS_KEY;
  let tls: TlsMaterial | null = null;
  if (certPath && keyPath) {
    tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  return { root, port, host, tls, allowHttp };
}
