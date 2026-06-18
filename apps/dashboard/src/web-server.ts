import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { DashboardState, DeviceLogEntry, DeviceTelemetry } from './contracts.js';
import type { DashboardRecorder } from './dashboard-recorder.js';
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

const CONTROL_PATHS: Record<string, string> = {
  'capture-start': '/api/v1/capture/start',
  'capture-stop': '/api/v1/capture/stop',
  'ota-check': '/api/v1/ota/check',
  'ota-apply': '/api/v1/ota/apply',
  reboot: '/api/v1/reboot',
};

export interface DashboardServerOptions {
  host: string;
  port: number;
  intervalMs: number;
  deviceUrl?: string;
  recorder?: DashboardRecorder;
}

export class DashboardServer {
  private readonly events = new EventStore();
  private readonly history: DashboardState[] = [];
  private readonly logs: DeviceLogEntry[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly server: Server;
  private timer: NodeJS.Timeout | null = null;
  private deviceTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastLogSequence = 0;
  private state: DashboardState;
  private device: DeviceTelemetry = {
    connected: false,
    lastUpdated: null,
    error: null,
    status: null,
    health: null,
    config: null,
  };

  constructor(
    private readonly engine: RealtimeEngine,
    private readonly options: DashboardServerOptions,
  ) {
    this.state = engine.snapshot();
    this.server = createServer((request, response) => void this.handle(request, response));
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
      this.deviceTimer = setInterval(() => void this.pollDevice(), 1500);
      this.deviceTimer.unref();
      void this.pollDevice();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.deviceTimer) clearInterval(this.deviceTimer);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private publish(): void {
    this.state = this.engine.snapshot();
    this.history.push({ ...this.state, amplitudeProfile: [], scores: {} });
    if (this.history.length > 1800) this.history.shift();
    this.broadcast('state', this.state);
    if (this.options.recorder?.status().active) {
      if (this.options.recorder.shouldAutoStop()) {
        void this.options.recorder.stop(true).then((status) => this.broadcast('recording', status));
        return;
      }
      this.broadcast('recording', this.options.recorder.status());
    }
  }

  private async pollDevice(): Promise<void> {
    if (!this.options.deviceUrl || this.polling) return;
    this.polling = true;
    try {
      const [status, health, config] = await Promise.all([
        this.deviceJson('/api/v1/status'),
        this.deviceJson('/api/v1/health'),
        this.deviceJson('/api/v1/config'),
      ]);
      this.device = {
        connected: true,
        lastUpdated: Date.now() / 1000,
        error: null,
        status,
        health,
        config,
      };
      await this.pollLogs();
    } catch (error) {
      this.device = {
        ...this.device,
        connected: false,
        lastUpdated: Date.now() / 1000,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.polling = false;
      this.broadcast('device', this.device);
    }
  }

  private async pollLogs(): Promise<void> {
    const path = `/api/v1/logs?after=${this.lastLogSequence}&limit=80`;
    const payload = (await this.deviceJson(path)) as { entries?: DeviceLogEntry[] };
    for (const entry of payload.entries ?? []) {
      if (entry.sequence <= this.lastLogSequence) continue;
      this.lastLogSequence = Math.max(this.lastLogSequence, entry.sequence);
      this.logs.push(entry);
      if (this.logs.length > 300) this.logs.shift();
      this.broadcast('log', entry);
    }
  }

  private async deviceJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    if (!this.options.deviceUrl) throw new Error('dashboard was started without --device');
    const response = await fetch(new URL(path, this.options.deviceUrl), {
      ...init,
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    const value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) throw new Error(String(value.error ?? `device HTTP ${response.status}`));
    return value;
  }

  private broadcast(event: string, value: unknown): void {
    const payload = JSON.stringify(value);
    for (const client of this.clients) client.write(`event: ${event}\ndata: ${payload}\n\n`);
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
      if (request.method === 'GET' && url.pathname === '/api/device') {
        this.sendJson(response, 200, this.device);
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
            rfDisturbance: true,
            coarseTrainedZone: false,
            peopleCount: false,
            pose: false,
            orientation: false,
            exactLocation: false,
            distance: false,
          },
          disclaimer:
            'A single RF link shows anonymous signal disturbance, not a measured person location.',
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
      if (request.method === 'GET' && url.pathname === '/api/recording') {
        this.sendJson(response, 200, this.recordingStatus());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/recording/start') {
        const body = await this.readBody(request);
        const status = await this.requireRecorder().start(
          String(body.label ?? 'recording'),
          Number(body.targetSeconds ?? 90),
          Number(body.targetFrames ?? 2000),
        );
        this.broadcast('recording', status);
        this.sendJson(response, 201, status);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/recording/stop') {
        const status = await this.requireRecorder().stop(true);
        this.broadcast('recording', status);
        this.sendJson(response, 200, status);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/baseline/reset') {
        this.engine.resetBaseline();
        this.sendJson(response, 200, { reset: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/control') {
        const body = await this.readBody(request);
        const action = String(body.action ?? '');
        const path = CONTROL_PATHS[action];
        if (!path) throw new Error(`unsupported device action: ${action}`);
        const result = await this.deviceJson(path, { method: 'POST' });
        this.sendJson(response, 200, result);
        setTimeout(() => void this.pollDevice(), 300).unref();
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
    response.write(`event: device\ndata: ${JSON.stringify(this.device)}\n\n`);
    response.write(`event: recording\ndata: ${JSON.stringify(this.recordingStatus())}\n\n`);
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  private recordingStatus(): unknown {
    return (
      this.options.recorder?.status() ?? {
        active: false,
        label: null,
        name: null,
        startedAt: null,
        finishedAt: null,
        datagrams: 0,
        frames: 0,
        bytes: 0,
        binPath: null,
        jsonlPath: null,
        metaPath: null,
        error: 'dashboard recorder is not configured',
      }
    );
  }

  private requireRecorder(): DashboardRecorder {
    if (!this.options.recorder) throw new Error('dashboard recorder is not configured');
    return this.options.recorder;
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
