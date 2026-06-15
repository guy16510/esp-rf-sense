import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { DashboardState } from './contracts.js';
import { EventStore } from './events.js';
import type { RealtimeEngine } from './engine.js';

const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/d3.js', 'd3.js'],
  ['/app.js', 'app.js'],
  ['/scene.js', 'scene.js'],
  ['/timeline.js', 'timeline.js'],
]);

export interface DashboardServerOptions {
  host: string;
  port: number;
  intervalMs: number;
}

export class DashboardServer {
  private readonly events = new EventStore();
  private readonly history: DashboardState[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly server: Server;
  private timer: NodeJS.Timeout | null = null;
  private state: DashboardState;

  constructor(
    private readonly engine: RealtimeEngine,
    private readonly options: DashboardServerOptions,
  ) {
    this.state = engine.snapshot();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.timer = setInterval(() => this.publish(), this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private publish(): void {
    this.state = this.engine.snapshot();
    this.history.push(this.compact(this.state));
    if (this.history.length > 1800) this.history.shift();
    const payload = JSON.stringify(this.state);
    for (const client of this.clients) client.write(`event: state\ndata: ${payload}\n\n`);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        await this.sendStatic(response, STATIC_FILES.get(url.pathname)!);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        this.sendJson(response, 200, this.state);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        const seconds = Math.min(600, Math.max(1, Number(url.searchParams.get('seconds') ?? 120)));
        const cutoff = Date.now() / 1000 - seconds;
        this.sendJson(response, 200, this.history.filter((item) => item.timestamp >= cutoff));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/meta') {
        this.sendJson(response, 200, {
          intervalMs: this.options.intervalMs,
          target: this.engine.modelTarget(),
          zones: this.engine.zones(),
          capabilities: {
            aggregateActivity: true,
            movement: true,
            coarseZone: Object.keys(this.engine.zones()).length > 0,
            timelineEvents: true,
            sse: true,
          },
          disclaimer:
            'The bubbles represent anonymous RF activity with uncertainty, not identified people or camera tracks.',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        this.sendJson(response, 200, this.events.list());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/events') {
        const body = await this.readBody(request);
        const value = this.events.add(
          String(body.type ?? 'note'),
          String(body.label ?? ''),
          String(body.groupId ?? ''),
          Number(body.timestamp ?? Date.now() / 1000),
        );
        this.sendJson(response, 201, value);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        this.openEventStream(response);
        return;
      }
      this.sendText(response, 404, 'not found');
    } catch (error) {
      this.sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private openEventStream(response: ServerResponse): void {
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

  private async sendStatic(response: ServerResponse, name: string): Promise<void> {
    const content = await readFile(`${PUBLIC_ROOT}${name}`);
    const contentType = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': name === 'index.html' ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(content);
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += value.length;
      if (length > 64 * 1024) throw new Error('request body is too large');
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  private compact(state: DashboardState): DashboardState {
    return { ...state, amplitudeProfile: [], scores: {} };
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

  private sendText(response: ServerResponse, status: number, value: string): void {
    const body = Buffer.from(value);
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    });
    response.end(body);
  }
}
