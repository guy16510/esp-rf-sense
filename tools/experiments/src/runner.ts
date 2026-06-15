// Remote experiment runner. One `start` brackets exactly one labeled capture session:
//   1. read device /status -> snapshot fw version, bootId, deviceId (recorded in metadata)
//   2. spawn the collector as a child (it tells the device to start capture and records raw CSI)
//   3. run for --duration seconds, or until Ctrl-C
//   4. SIGINT the collector for a clean stop (it stops device capture + closes the recording)
//   5. read the collector's recording stats + device /health, finalize the session metadata
//
// The collector is the authoritative recorder; the runner never touches CSI bytes. If anything
// fails mid-session the metadata keeps complete:false so the dataset is honestly flagged.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiCall, type DeviceTarget } from './deviceApi.js';
import {
  validateMetadata,
  type CaptureCounts,
  type DeviceSnapshot,
  type ExperimentMetadata,
} from './metadata.js';
import { TEMPLATES } from './templates.js';

const COLLECTOR_CLI = fileURLToPath(new URL('../../collector/src/cli.ts', import.meta.url));

export interface StartOptions {
  device: DeviceTarget;
  experimentId: string;
  group: string; // template key
  room: string;
  durationS: number;
  collectorPort: number;
  outDir: string;
  channel: number;
  pingPps: number;
  txDescription: string;
  subjectIds: string[];
  label?: string;
  notes?: string;
  day?: string; // defaults to today (UTC)
}

async function deviceSnapshot(target: DeviceTarget): Promise<DeviceSnapshot | undefined> {
  try {
    const res = await apiCall(target, 'GET', '/status');
    if (res.status !== 200) return undefined;
    const s = res.json as {
      deviceId?: number;
      bootId?: number;
      deviceName?: string;
      firmware?: {
        version?: string;
        gitCommit?: string;
        target?: string;
        board?: string;
        protocolVersion?: number;
      };
    };
    return {
      deviceId: (s.deviceId ?? 0).toString(16).padStart(8, '0'),
      deviceName: s.deviceName ?? '',
      firmwareVersion: s.firmware?.version ?? '',
      gitCommit: s.firmware?.gitCommit ?? '',
      bootId: s.bootId ?? 0,
      target: s.firmware?.target ?? '',
      board: s.firmware?.board ?? '',
      protocolVersion: s.firmware?.protocolVersion ?? 0,
    };
  } catch {
    return undefined;
  }
}

async function readCollectorCounts(outDir: string, recordingName: string): Promise<CaptureCounts> {
  try {
    const meta = JSON.parse(await readFile(join(outDir, `${recordingName}.meta.json`), 'utf8')) as {
      stats?: {
        validDatagrams?: number;
        invalidDatagrams?: number;
        reboots?: number;
        streams?: Array<{ framesReceived?: number; lossPpm?: number }>;
      };
    };
    const stats = meta.stats;
    const frames = (stats?.streams ?? []).reduce((a, s) => a + (s.framesReceived ?? 0), 0);
    const worstLoss = (stats?.streams ?? []).reduce((a, s) => Math.max(a, s.lossPpm ?? 0), 0);
    return {
      validDatagrams: stats?.validDatagrams ?? 0,
      invalidDatagrams: stats?.invalidDatagrams ?? 0,
      framesReceived: frames,
      reboots: stats?.reboots ?? 0,
      collectorPacketLossPpm: worstLoss,
    };
  } catch {
    return {};
  }
}

async function readDeviceDrops(target: DeviceTarget): Promise<Partial<CaptureCounts>> {
  try {
    const res = await apiCall(target, 'GET', '/health');
    if (res.status !== 200) return {};
    const h = res.json as { csiQueueDrops?: number; networkQueueDrops?: number };
    return {
      ...(h.csiQueueDrops !== undefined ? { deviceCsiQueueDrops: h.csiQueueDrops } : {}),
      ...(h.networkQueueDrops !== undefined
        ? { deviceNetworkQueueDrops: h.networkQueueDrops }
        : {}),
    };
  } catch {
    return {};
  }
}

export function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function spawnCollector(opts: StartOptions, recordingName: string) {
  const args = [
    'tsx',
    COLLECTOR_CLI,
    '--port',
    String(opts.collectorPort),
    '--out',
    opts.outDir,
    '--name',
    recordingName,
    '--device',
    opts.device.baseUrl,
  ];
  if (opts.device.token) args.push('--token', opts.device.token);
  // shell:false + explicit arg array: the token never passes through a shell, so no injection.
  return spawn('npx', args, { stdio: ['ignore', 'inherit', 'inherit'], shell: false });
}

export async function startExperiment(opts: StartOptions): Promise<ExperimentMetadata> {
  const template = TEMPLATES[opts.group];
  if (!template) {
    throw new Error(`unknown group "${opts.group}" (see: experiment list-templates)`);
  }

  const now = new Date();
  const sessionId = `${opts.group}-${now.toISOString().replace(/[:.]/g, '-')}`;
  const recordingName = sessionId;
  const day = opts.day ?? now.toISOString().slice(0, 10);

  const snapshot = await deviceSnapshot(opts.device);

  const metadata: ExperimentMetadata = {
    schemaVersion: 1,
    experimentId: opts.experimentId,
    sessionId,
    group: opts.group,
    label: opts.label ?? template.label,
    room: opts.room,
    day,
    captureMode: template.defaults.captureMode,
    link: {
      txDescription: opts.txDescription,
      channel: opts.channel,
      pingPps: opts.pingPps,
    },
    subject: {
      count: opts.subjectIds.length || template.defaults.subjectCount,
      subjectIds: opts.subjectIds,
      movement: template.defaults.movement,
    },
    recordingName,
    startedAt: now.toISOString(),
    complete: false,
    ...(snapshot ? { device: snapshot } : {}),
    notes: opts.notes ?? '',
  };

  const check = validateMetadata(metadata);
  if (!check.ok) {
    throw new Error(`invalid experiment metadata:\n  - ${check.errors.join('\n  - ')}`);
  }

  await mkdir(opts.outDir, { recursive: true });
  const sessionPath = join(opts.outDir, `${sessionId}.session.json`);
  await writeFile(sessionPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.error(`[experiment] session ${sessionId} (${template.description})`);
  console.error(`[experiment] metadata: ${sessionPath}`);

  const child = spawnCollector(opts, recordingName);
  const childExit = waitForChild(child);

  let stopped = false;
  const stop = async (reason: string) => {
    if (stopped) return;
    stopped = true;
    console.error(`[experiment] stopping (${reason})`);
    child.kill('SIGINT'); // collector stops device capture + closes the recording cleanly
    await childExit;
  };

  const onSig = () => void stop('signal');
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const timer = setTimeout(() => void stop('duration elapsed'), opts.durationS * 1000);
  console.error(`[experiment] capturing for ${opts.durationS}s (Ctrl-C to stop early)...`);
  let exitCode: number | null;
  try {
    exitCode = await childExit;
  } catch (error) {
    metadata.endedAt = new Date().toISOString();
    metadata.failureReason = `collector failed to start: ${(error as Error).message}`;
    await writeFile(sessionPath, `${JSON.stringify(metadata, null, 2)}\n`);
    throw error;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }

  const counts = {
    ...(await readCollectorCounts(opts.outDir, recordingName)),
    ...(await readDeviceDrops(opts.device)),
  };
  metadata.endedAt = new Date().toISOString();
  metadata.counts = counts;
  metadata.complete = exitCode === 0 && (counts.framesReceived ?? 0) > 0;
  if (!metadata.complete) {
    metadata.failureReason =
      exitCode === 0 ? 'collector recorded no frames' : `collector exited with code ${exitCode}`;
  }
  await writeFile(sessionPath, `${JSON.stringify(metadata, null, 2)}\n`);
  if (!metadata.complete) {
    throw new Error(metadata.failureReason);
  }
  console.error(
    `[experiment] done: ${counts.framesReceived ?? 0} frames, ` +
      `loss ~${counts.collectorPacketLossPpm ?? 0} ppm, reboots ${counts.reboots ?? 0}`,
  );
  return metadata;
}
