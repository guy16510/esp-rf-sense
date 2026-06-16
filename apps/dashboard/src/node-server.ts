import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { DashboardState } from './contracts.js';
import { EventStore } from './events.js';
import type { NodeEngine } from './node-engine.js';

const LEGACY_ROOT = fileURLToPath(new URL('../../../tools/analysis/rfsense_analysis/web/', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/d3.js', 'd3.js'],
  ['/scene-view.js', 'scene-view.js'],
  ['/timeline.js', 'timeline.js'],
  ['/boot.js', 'boot.js'],
]);

export class NodeDashboardServer {
  private readonly events = new EventStore();
  private readonly history: DashboardState[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly server = createServer((request, response) => void this.handle(request, response));
  private timer: NodeJS.Timeout | null = null;
  private state: DashboardState;

  constructor(
    private readonly engine: NodeEngine,
    private readonly host: string,
    private readonly port: number,
    private readonly intervalMs: number,
  ) {
    this.state = engine.snapshot();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.timer = setInterval(() => this.publish(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private publish(): void {
    this.state = this.engine.snapshot();
    this.history.push({ ...this.state, amplitudeProfile: [], scores: {} });
    if (this.history.length > 1800) this.history.shift();
    const data = JSON.stringify(this.state);
    for (const client of this.clients) client.write(`event: state\ndata: ${data}\n\n`);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const file = FILES.get(url.pathname);
      if (request.method === 'GET' && file) return void (await this.sendFile(response, file));
      if (request.method === 'GET' && url.pathname === '/api/state') return void this.json(response, 200, this.state);
      if (request.method === 'GET' && url.pathname === '/api/history') {
        const seconds = Math.min(600, Math.max(1, Number(url.searchParams.get('seconds') ?? 120)));
        const cutoff = Date.now() / 1000 - seconds;
        return void this.json(response, 200, this.history.filter((item) => item.timestamp >= cutoff));
      }
      if (request.method === 'GET' && url.pathname === '/api/meta') {
        return void this.json(response, 200, {
          streamIntervalMs: this.intervalMs,
          target: 'presence',
          zones: {},
          capabilities: {
            sceneHypotheses: true,
            peopleCount: false,
            pose: false,
            orientation: false,
            coarseDirection: false,
            campaignMarkers: true,
            history: true,
          },
          disclaimer: 'The display shows anonymous aggregate RF activity with uncertainty.',
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') return void this.json(response, 200, this.events.list());
      if (request.method === 'POST' && url.pathname === '/api/events') {
        const body = await this.body(request);
        const event = this.events.add(
          String(body.type ?? 'note'),
          String(body.label ?? ''),
          String(body.groupId ?? ''),
          Number(body.timestamp ?? Date.now() / 1000),
        );
        return void this.json(response, 201, event);
      }
      if (request.method === 'GET' && url.pathname === '/events') return void this.openStream(response);
      this.text(response, 404, 'not found');
    } catch (error) {
      this.json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private openStream(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`event: state\ndata: ${JSON.stringify(this.state)}\n\n`);
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  private async sendFile(response: ServerResponse, name: string): Promise<void> {
    const root = name === 'boot.js' ? APP_ROOT : LEGACY_ROOT;
    const content = await readFile(`${root}${name}`);
    const contentType = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length });
    response.end(content);
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += value.length;
      if (length > 64 * 1024) throw new Error('request body is too large');
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
    return parsed as Record<string, unknown>;
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const content = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': content.length });
    response.end(content);
  }

  private text(response: ServerResponse, status: number, value: string): void {
    const content = Buffer.from(value);
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': content.length });
    response.end(content);
  }
}
