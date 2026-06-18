import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { MultiNodeEngine } from './multi-node-engine.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));

export class SensorUiServer {
  private readonly server = createServer((request, response) => {
    void this.route(request.url ?? '/', request.method ?? 'GET', response);
  });

  constructor(
    private readonly engine: MultiNodeEngine,
    private readonly host: string,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async route(path: string, method: string, response: ServerResponse): Promise<void> {
    const url = new URL(path, 'http://localhost');
    const state = this.engine.snapshot();
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/lab')) {
      return this.sendFile(response, 'lab.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/lab.js') {
      return this.sendFile(response, 'lab.js', 'text/javascript; charset=utf-8');
    }
    if (method === 'GET' && url.pathname === '/api/lab/state') {
      return this.sendJson(response, 200, state);
    }
    if (method === 'GET' && url.pathname === '/api/lab/readiness') {
      return this.sendJson(response, 200, state.readiness);
    }
    if (method === 'GET' && url.pathname === '/api/nodes') {
      return this.sendJson(response, 200, state.nodes);
    }
    return this.sendJson(response, 404, { error: 'not found' });
  }

  private async sendFile(response: ServerResponse, name: string, type: string): Promise<void> {
    const body = await readFile(`${root}${name}`);
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    response.end(body);
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }
}
