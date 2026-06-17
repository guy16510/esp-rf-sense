import { createServer, type ServerResponse } from 'node:http';

import type { MultiNodeEngine } from './multi-node-engine.js';

export class LabServer {
  private readonly server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const state = this.engine.snapshot();

    if (request.method === 'GET' && url.pathname === '/api/lab/state') {
      return this.json(response, 200, state);
    }
    if (request.method === 'GET' && url.pathname === '/api/lab/readiness') {
      return this.json(response, 200, state.readiness);
    }
    if (request.method === 'GET' && url.pathname === '/api/nodes') {
      return this.json(response, 200, state.nodes);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/nodes/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/nodes/'.length));
      const node = state.nodes.find((candidate) => candidate.deviceId === id);
      return this.json(response, node ? 200 : 404, node ?? { error: 'node not found' });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return this.json(response, 200, {
        service: 'rf-sense-four-node-lab',
        source: 'real',
        warning: 'No simulation fallback is enabled.',
        readiness: state.readiness,
        endpoints: ['/api/lab/state', '/api/lab/readiness', '/api/nodes'],
      });
    }
    return this.json(response, 404, { error: 'not found' });
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

  private json(response: ServerResponse, status: number, value: unknown): void {
    const content = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': content.length,
      'Access-Control-Allow-Origin': '*',
    });
    response.end(content);
  }
}
