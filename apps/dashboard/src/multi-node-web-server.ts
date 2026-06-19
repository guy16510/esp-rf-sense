import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { DashboardState } from './contracts.js';
import { trainDashboardModel } from './dashboard-model-trainer.js';
import type { DashboardRecorder } from './dashboard-recorder.js';
import { loadPortableModel } from './model.js';
import type { MultiNodeEngine, MultiNodeSnapshot } from './multi-node-engine.js';
import { loadRoomGeometry, validateRoomGeometry } from './room-geometry.js';

const APP_PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_FILES = new Map<string, { root: string; name: string }>([
  ['/', { root: APP_PUBLIC_ROOT, name: 'four-node-dashboard.html' }],
  ['/index.html', { root: APP_PUBLIC_ROOT, name: 'four-node-dashboard.html' }],
  ['/four-node-dashboard.css', { root: APP_PUBLIC_ROOT, name: 'four-node-dashboard.css' }],
  ['/four-node-dashboard.js', { root: APP_PUBLIC_ROOT, name: 'four-node-dashboard.js' }],
  ['/four-node-dashboard-core.js', { root: APP_PUBLIC_ROOT, name: 'four-node-dashboard-core.js' }],
  ['/room-d3.js', { root: APP_PUBLIC_ROOT, name: 'room-d3.js' }],
  ['/room-d3.css', { root: APP_PUBLIC_ROOT, name: 'room-d3.css' }],
  ['/fleet', { root: APP_PUBLIC_ROOT, name: 'fleet.html' }],
  ['/fleet.html', { root: APP_PUBLIC_ROOT, name: 'fleet.html' }],
  ['/fleet.js', { root: APP_PUBLIC_ROOT, name: 'fleet.js' }],
  ['/fleet.css', { root: APP_PUBLIC_ROOT, name: 'fleet.css' }],
]);

export interface MultiNodeServerOptions {
  host: string;
  port: number;
  intervalMs: number;
  recorder?: DashboardRecorder;
  recordingsDir: string;
  modelPath: string;
  model?: ModelStatus;
  slotDeviceIds?: string[];
}

interface ModelStatus {
  loaded: boolean;
  path: string | null;
  target: string | null;
  classes: string[];
  trainedAt: string | null;
  recordings: number | null;
  windows: number | null;
  error: string | null;
}

export class MultiNodeDashboardServer {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly history: DashboardState[] = [];
  private timer: NodeJS.Timeout | null = null;
  private state: MultiNodeSnapshot;
  private modelStatus: ModelStatus;

  constructor(
    private readonly engine: MultiNodeEngine,
    private readonly options: MultiNodeServerOptions,
  ) {
    this.state = engine.snapshot();
    this.modelStatus = options.model ?? {
      loaded: false,
      path: null,
      target: null,
      classes: [],
      trainedAt: null,
      recordings: null,
      windows: null,
      error: null,
    };
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
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  address(): { port: number } | null {
    const value = this.server.address();
    return value && typeof value === 'object' ? { port: value.port } : null;
  }

  private publish(): void {
    this.state = this.engine.snapshot();
    const fused = this.state.fused;
    this.history.push({ ...fused, amplitudeProfile: [], scores: {} });
    if (this.history.length > 1800) this.history.shift();
    this.broadcast('state', fused);
    this.broadcast('nodes', this.state);
    if (this.options.recorder?.status().active) {
      if (this.options.recorder.shouldAutoStop()) {
        void this.options.recorder.stop(true).then((status) => this.broadcast('recording', status));
      } else {
        this.broadcast('recording', this.options.recorder.status());
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const file = STATIC_FILES.get(url.pathname);
      if (request.method === 'GET' && file) {
        await this.sendStatic(response, file.root, file.name);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state')
        return void this.sendJson(response, 200, this.state.fused);
      if (request.method === 'GET' && url.pathname === '/api/nodes')
        return void this.sendJson(response, 200, this.withSlots(this.state));
      if (request.method === 'GET' && url.pathname === '/api/readiness')
        return void this.sendJson(response, 200, this.state.readiness);
      if (request.method === 'GET' && url.pathname === '/api/device')
        return void this.sendJson(response, 200, {
          connected: false,
          lastUpdated: null,
          error: 'device control is separate from the four-node RF stream',
          status: null,
          health: null,
          config: null,
        });
      if (request.method === 'GET' && url.pathname === '/api/logs')
        return void this.sendJson(response, 200, {
          deviceUrl: null,
          latestSequence: 0,
          entries: [],
        });
      if (request.method === 'GET' && url.pathname === '/api/history') {
        const seconds = Math.min(600, Math.max(1, Number(url.searchParams.get('seconds') ?? 120)));
        const cutoff = Date.now() / 1000 - seconds;
        return void this.sendJson(
          response,
          200,
          this.history.filter((item) => item.timestamp >= cutoff),
        );
      }
      if (request.method === 'GET' && url.pathname === '/api/meta')
        return void this.sendJson(response, 200, {
          streamIntervalMs: this.options.intervalMs,
          slotDeviceIds: this.options.slotDeviceIds ?? [],
          target: this.modelStatus.loaded ? this.modelStatus.target : 'presence',
          zones: {},
          capabilities: {
            rfDisturbance: true,
            multiNode: true,
            fusedRfActivity: true,
            trainedLabels: this.modelStatus.loaded,
            peopleCount: false,
            pose: false,
            orientation: false,
            exactLocation: false,
            distance: false,
          },
          disclaimer:
            'Four RF links provide fused disturbance evidence, not pose, identity, exact range, or people count.',
        });
      if (request.method === 'GET' && url.pathname === '/api/events')
        return void this.sendJson(response, 200, []);
      if (request.method === 'POST' && url.pathname === '/api/events')
        return void this.sendJson(response, 201, await this.readBody(request));
      if (request.method === 'GET' && url.pathname === '/api/recording')
        return void this.sendJson(response, 200, this.recordingStatus());
      if (request.method === 'GET' && url.pathname === '/api/model')
        return void this.sendJson(response, 200, this.modelStatus);
      if (request.method === 'POST' && url.pathname === '/api/model/train') {
        const body = await this.readBody(request);
        const outPath = String(body.path || this.options.modelPath);
        const target = body.target === 'label' ? 'label' : 'position';
        const geometry =
          body.roomGeometry && typeof body.roomGeometry === 'object'
            ? validateRoomGeometry(body.roomGeometry)
            : typeof body.roomGeometryPath === 'string' && body.roomGeometryPath.trim()
              ? await loadRoomGeometry(body.roomGeometryPath)
              : undefined;
        const minRecordingsPerClass =
          body.minRecordingsPerClass === undefined
            ? undefined
            : Math.max(1, Math.floor(Number(body.minRecordingsPerClass)));
        const trained = await trainDashboardModel({
          recordingsDir: this.options.recordingsDir,
          outPath,
          window: Math.max(8, Number(body.window ?? 64)),
          step: Math.max(1, Number(body.step ?? 32)),
          target,
          ...(geometry ? { geometry } : {}),
          ...(minRecordingsPerClass ? { minRecordingsPerClass } : {}),
        });
        const loaded = await loadPortableModel(outPath);
        this.engine.setModel(loaded);
        this.modelStatus = {
          loaded: true,
          path: outPath,
          target: trained.summary.target,
          classes: trained.summary.classes,
          trainedAt: trained.summary.trainedAt,
          recordings: trained.summary.recordings,
          windows: trained.summary.windows,
          error: null,
        };
        this.broadcast('model', this.modelStatus);
        return void this.sendJson(response, 201, this.modelStatus);
      }
      if (request.method === 'POST' && url.pathname === '/api/model/load') {
        const body = await this.readBody(request);
        const path = String(body.path || this.options.modelPath);
        const loaded = await loadPortableModel(path);
        this.engine.setModel(loaded);
        this.modelStatus = {
          loaded: true,
          path,
          target: loaded.bundle.target,
          classes: loaded.bundle.classes,
          trainedAt: null,
          recordings: null,
          windows: null,
          error: null,
        };
        this.broadcast('model', this.modelStatus);
        return void this.sendJson(response, 200, this.modelStatus);
      }
      if (request.method === 'POST' && url.pathname === '/api/recording/start') {
        if (!this.state.readiness.readyForCapture)
          throw new Error(`capture blocked: ${this.state.readiness.reasons.join('; ')}`);
        const body = await this.readBody(request);
        const status = await this.requireRecorder().start(
          String(body.label ?? 'recording'),
          Number(body.targetSeconds ?? 90),
          Number(body.targetFrames ?? 2000),
        );
        this.broadcast('recording', status);
        return void this.sendJson(response, 201, status);
      }
      if (request.method === 'POST' && url.pathname === '/api/recording/stop') {
        const status = await this.requireRecorder().stop(true);
        this.broadcast('recording', status);
        return void this.sendJson(response, 200, status);
      }
      if (request.method === 'POST' && url.pathname === '/api/baseline/reset') {
        const body = await this.readBody(request);
        this.engine.resetBaseline(body.deviceId ? String(body.deviceId) : undefined);
        return void this.sendJson(response, 200, {
          reset: true,
          deviceId: body.deviceId ?? 'all',
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/control')
        throw new Error('device controls are not available in four-node dashboard mode');
      if (request.method === 'GET' && url.pathname === '/events')
        return void this.openEventStream(response);
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
    response.write(`event: state\ndata: ${JSON.stringify(this.state.fused)}\n\n`);
    response.write(`event: nodes\ndata: ${JSON.stringify(this.withSlots(this.state))}\n\n`);
    response.write(
      `event: device\ndata: ${JSON.stringify({ connected: false, error: 'four-node RF stream mode' })}\n\n`,
    );
    response.write(`event: recording\ndata: ${JSON.stringify(this.recordingStatus())}\n\n`);
    response.write(`event: model\ndata: ${JSON.stringify(this.modelStatus)}\n\n`);
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  private broadcast(event: string, value: unknown): void {
    const payload = JSON.stringify(event === 'nodes' ? this.withSlots(value) : value);
    for (const client of this.clients) client.write(`event: ${event}\ndata: ${payload}\n\n`);
  }

  private withSlots(value: unknown): unknown {
    if (!this.options.slotDeviceIds || this.options.slotDeviceIds.length === 0) return value;
    if (typeof value !== 'object' || value === null) return value;
    return { ...value, slotDeviceIds: this.options.slotDeviceIds };
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
        error: 'dashboard recorder is not configured',
      }
    );
  }

  private requireRecorder(): DashboardRecorder {
    if (!this.options.recorder) throw new Error('dashboard recorder is not configured');
    return this.options.recorder;
  }

  private async sendStatic(response: ServerResponse, root: string, name: string): Promise<void> {
    const content = await readFile(`${root}${name}`);
    const contentType = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control':
        name.endsWith('.html') || name.endsWith('.js') ? 'no-store' : 'public, max-age=300',
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('request body must be a JSON object');
    return parsed as Record<string, unknown>;
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const content = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': content.length,
    });
    response.end(content);
  }

  private sendText(response: ServerResponse, status: number, value: string): void {
    const content = Buffer.from(value);
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': content.length,
    });
    response.end(content);
  }
}
