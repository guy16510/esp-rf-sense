import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { DashboardState, DeviceLogEntry } from './contracts.js';
import { EventStore } from './events.js';
import type { RealtimeEngine } from './engine.js';

const LEGACY_PUBLIC_ROOT = fileURLToPath(
  new URL('../../../tools/analysis/rfsense_analysis/web/', import.meta.url),
);
const APP_PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/d3.js', 'd3.js'],
  ['/scene-view.js', 'scene-view.js'],
  ['/timeline.js', 'timeline.js'],
  ['/boot.js', 'boot.js'],
]);

export interface DashboardServerOptions {
  host: string;
  port: number;
  intervalMs: number;
  deviceUrl?: string;
}

export class DashboardServer {
  private readonly events = new EventStore();
  private readonly history: DashboardState[] = [];
  private readonly logs: DeviceLogEntry[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly server: Server;
  private timer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  private logPollActive = false;
  private lastLogSequence = 0;
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
    if (this.options.deviceUrl) {
      this.logTimer = setInterval(() => void this.pollLogs(), 1000);
      this.logTimer.unref();
      void this.pollLogs();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.logTimer) clearInterval(this.logTimer);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private publish(): void {
    this.state = this.engine.snapshot();
    this.history.push({ ...this.state, amplitudeProfile: [], scores: {} });
    if (this.history.length > 1800) this.history.shift();
    const payload = JSON.stringify(this.state);
    for (const client of this.clients) client.write(`event: state\ndata: ${payload}\n\n`);
  }

  private async pollLogs(): Promise<void> {
    if (!this.options.deviceUrl) return;
    if (this.logPollActive) return;
    this.logPollActive = true;
    try {
      const url = new URL('/api/v1/logs', this.options.deviceUrl);
      url.searchParams.set('after', String(this.lastLogSequence));
      url.searchParams.set('limit', '80');
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return;
      const payload = (await response.json()) as { entries?: DeviceLogEntry[] };
      for (const entry of payload.entries ?? []) {
        if (entry.sequence <= this.lastLogSequence) continue;
        this.lastLogSequence = Math.max(this.lastLogSequence, entry.sequence);
        this.logs.push(entry);
        if (this.logs.length > 300) this.logs.shift();
        const data = JSON.stringify(entry);
        for (const client of this.clients) client.write(`event: log\ndata: ${data}\n\n`);
      }
    } catch {
      // The device may reboot or be temporarily unreachable; state streaming should continue.
    } finally {
      this.logPollActive = false;
    }
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
        this.sendJson(
          response,
          200,
          this.history.filter((item) => item.timestamp >= cutoff),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/meta') {
        this.sendJson(response, 200, {
          streamIntervalMs: this.options.intervalMs,
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
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        this.sendJson(response, 200, this.events.list());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/logs') {
        this.sendJson(response, 200, {
          deviceUrl: this.options.deviceUrl ?? null,
          latestSequence: this.lastLogSequence,
          entries: this.logs,
        });
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
      this.sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
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
    const root = name === 'boot.js' ? APP_PUBLIC_ROOT : LEGACY_PUBLIC_ROOT;
    const content = await readFile(`${root}${name}`);
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
