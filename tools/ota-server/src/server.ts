// HTTPS manifest + firmware server. Routes:
//   GET /health                     -> JSON: validation summary + advertised versions
//   GET /manifest/stable.json       -> the stable channel manifest
//   GET /manifest/development.json  -> the development channel manifest
//   GET /firmware/:version/rf-sense.bin -> the firmware image for a version
//
// All file serving is confined to <root> with no path traversal: the version path segment is
// validated against a strict pattern and never joined with caller-controlled separators.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';

import type { OtaServerConfig } from './config.js';
import { firmwarePathFor, validateOtaRoot, type ManifestResult } from './validate.js';

const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function createOtaServer(config: OtaServerConfig, validation: ManifestResult[]) {
  const summary = validation.map((r) => ({
    channel: r.channel,
    present: r.present,
    version: r.manifest?.version ?? null,
    errors: r.issues.filter((i) => i.level === 'error').length,
    warnings: r.issues.filter((i) => i.level === 'warn').length,
  }));

  const handler: Handler = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (path === '/health') {
      sendJson(res, 200, { ok: true, channels: summary });
      return;
    }

    if (path === '/manifest/stable.json' || path === '/manifest/development.json') {
      const channel = path.includes('stable') ? 'stable' : 'development';
      const manifestPath = join(config.root, 'manifest', `${channel}.json`);
      if (!(await fileExists(manifestPath))) {
        sendJson(res, 404, { error: `no ${channel} manifest` });
        return;
      }
      const body = await readFile(manifestPath);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
      return;
    }

    const fw = /^\/firmware\/([^/]+)\/rf-sense\.bin$/.exec(path);
    if (fw) {
      const version = decodeURIComponent(fw[1]!);
      if (!VERSION_RE.test(version)) {
        sendJson(res, 400, { error: 'invalid version' });
        return;
      }
      const fwPath = firmwarePathFor(config.root, version);
      if (!(await fileExists(fwPath))) {
        sendJson(res, 404, { error: 'firmware not found' });
        return;
      }
      const st = await stat(fwPath);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
      });
      createReadStream(fwPath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };

  const wrapped: Handler = (req, res) => {
    Promise.resolve(handler(req, res)).catch((err: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  };

  return config.tls
    ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key }, wrapped)
    : createHttpServer(wrapped);
}

export async function revalidate(root: string): Promise<ManifestResult[]> {
  return validateOtaRoot(root);
}
