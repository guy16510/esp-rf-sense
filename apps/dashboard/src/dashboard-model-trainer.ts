import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PortableModelBundle } from './contracts.js';
import { decodeAmplitude, windowFeatures } from './features.js';
import {
  fitPrototype,
  type TrainingExample,
  validateExamples,
} from './prototype-training.js';
import { parseDatagram } from './protocol.js';
import { normalizeRoomPoint, type RoomGeometry } from './room-geometry.js';

interface RecordingPosition {
  label: string;
  x: number | null;
  y: number | null;
}

interface RecordingMeta {
  name: string;
  label: string;
  target?: 'label' | 'position';
  complete: boolean;
  subjectId?: string;
  subject?: {
    id?: string;
    position?: RecordingPosition;
  };
  day?: string;
  movement?: string;
  position?: RecordingPosition;
}

interface TrainingSummary {
  path: string;
  target: 'label' | 'position';
  classes: string[];
  recordings: number;
  windows: number;
  window: number;
  trainedAt: string;
  validation: PortableModelBundle['validation'];
}

export interface TrainedDashboardModel {
  bundle: PortableModelBundle;
  summary: TrainingSummary;
}

export async function trainDashboardModel(options: {
  recordingsDir: string;
  outPath: string;
  window: number;
  step: number;
  target?: 'label' | 'position';
  geometry?: RoomGeometry;
  minRecordingsPerClass?: number;
}): Promise<TrainedDashboardModel> {
  const target = options.target ?? 'position';
  const metas = await loadMetas(options.recordingsDir);
  const examples: TrainingExample[] = [];
  const coordinates = new Map<string, { x: number | null; y: number | null }>();
  const recordingsByClass = new Map<string, Set<string>>();
  const incompleteMetadata: string[] = [];

  for (const meta of metas) {
    if (!meta.complete || meta.label === 'auto-smoke') continue;
    if (meta.target && meta.target !== target) continue;
    const position = positionFor(meta);
    const subjectId = subjectIdFor(meta);
    const label = classLabel(meta, target);
    if (!label) {
      incompleteMetadata.push(`${meta.name} (position label)`);
      continue;
    }
    if (target === 'position' && !String(meta.day ?? '').trim()) {
      incompleteMetadata.push(`${meta.name} (day)`);
      continue;
    }
    if (target === 'position' && !/empty|clear/iu.test(meta.label) && !subjectId) {
      incompleteMetadata.push(`${meta.name} (subject ID)`);
      continue;
    }

    const streams = await readAmplitudeStreams(
      join(options.recordingsDir, `${meta.name}.csi.bin`),
    );
    const rows = streams.flatMap((stream) => windowsFor(stream, options.window, options.step));
    if (rows.length === 0) continue;

    const point = coordinatesFor(label, meta, options.geometry, target);
    if (target === 'position') mergeCoordinates(coordinates, label, point);
    const recordings = recordingsByClass.get(label) ?? new Set<string>();
    recordings.add(meta.name);
    recordingsByClass.set(label, recordings);
    for (const features of rows) {
      examples.push({
        features,
        label,
        recordingId: meta.name,
        subjectId,
        day: String(meta.day ?? '').trim(),
        position: String(position?.label ?? (/empty|clear/iu.test(meta.label) ? 'empty' : '')),
      });
    }
  }

  if (incompleteMetadata.length > 0) {
    throw new Error(
      `position recordings are missing required metadata: ${incompleteMetadata.join(', ')}`,
    );
  }
  if (examples.length === 0) throw new Error('no complete recordings produced training windows');
  const classes = [...new Set(examples.map((example) => example.label))].sort();
  validateClassCoverage(classes, target);

  const minimum = Math.max(
    1,
    Math.floor(options.minRecordingsPerClass ?? (target === 'position' ? 2 : 1)),
  );
  const underSampled = classes.filter(
    (label) => (recordingsByClass.get(label)?.size ?? 0) < minimum,
  );
  if (underSampled.length > 0) {
    throw new Error(
      `collect at least ${minimum} independent recordings per class; under-sampled: ${underSampled.join(', ')}`,
    );
  }

  const fitted = fitPrototype(examples);
  const validation = validateExamples(examples);
  const bundle: PortableModelBundle = {
    format: 'rfsense-portable-model/1',
    target,
    window: options.window,
    nFeatures: fitted.mean.length,
    classes,
    featureMean: fitted.mean,
    featureScale: fitted.scale,
    prototypes: fitted.prototypes,
    zones: Object.fromEntries(
      classes.map((label) => [label, coordinates.get(label) ?? { x: null, y: null }]),
    ),
    temperature: fitted.temperature,
    confidenceThreshold: fitted.confidenceThreshold,
    marginThreshold: fitted.marginThreshold,
    distanceThreshold: fitted.distanceThreshold,
    validation,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    bundle,
    summary: {
      path: options.outPath,
      target,
      classes,
      recordings: new Set(examples.map((example) => example.recordingId)).size,
      windows: examples.length,
      window: options.window,
      trainedAt: new Date().toISOString(),
      validation,
    },
  };
}

function validateClassCoverage(classes: string[], target: 'label' | 'position'): void {
  if (classes.length < 2) {
    throw new Error(`need at least two recorded ${target} classes; found ${classes.join(', ')}`);
  }
  if (target !== 'position') return;
  if (!classes.some((label) => /empty|clear/iu.test(label))) {
    throw new Error('position training requires an empty-room class');
  }
  if (classes.filter((label) => !/empty|clear/iu.test(label)).length < 2) {
    throw new Error('position training requires at least two occupied zones');
  }
}

function classLabel(meta: RecordingMeta, target: 'label' | 'position'): string {
  if (target === 'label') return String(meta.label ?? '').trim();
  if (/empty|clear/iu.test(meta.label)) return 'empty';
  return String(positionFor(meta)?.label ?? '').trim();
}

function subjectIdFor(meta: RecordingMeta): string {
  return String(meta.subjectId ?? meta.subject?.id ?? '').trim();
}

function positionFor(meta: RecordingMeta): RecordingPosition | undefined {
  return meta.position ?? meta.subject?.position;
}

function coordinatesFor(
  label: string,
  meta: RecordingMeta,
  geometry: RoomGeometry | undefined,
  target: 'label' | 'position',
): { x: number | null; y: number | null } {
  if (target !== 'position' || /empty|clear/iu.test(label)) return { x: null, y: null };
  const configured = geometry?.zones[label];
  if (configured && geometry) return normalizeRoomPoint(geometry, configured);
  const position = positionFor(meta);
  const x = position?.x;
  const y = position?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`position ${label} is missing calibrated normalized x/y coordinates`);
  }
  if (Number(x) < 0 || Number(x) > 1 || Number(y) < 0 || Number(y) > 1) {
    throw new Error(`position ${label} x/y coordinates must be between 0 and 1`);
  }
  return { x: Number(x), y: Number(y) };
}

function mergeCoordinates(
  coordinates: Map<string, { x: number | null; y: number | null }>,
  label: string,
  point: { x: number | null; y: number | null },
): void {
  const existing = coordinates.get(label);
  if (
    existing !== undefined &&
    existing.x !== null &&
    existing.y !== null &&
    point.x !== null &&
    point.y !== null &&
    (Math.abs(existing.x - point.x) > 0.05 || Math.abs(existing.y - point.y) > 0.05)
  ) {
    throw new Error(`position ${label} has inconsistent coordinates across recordings`);
  }
  coordinates.set(label, point);
}

async function loadMetas(recordingsDir: string): Promise<RecordingMeta[]> {
  const names = await readdir(recordingsDir);
  return Promise.all(
    names
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => JSON.parse(await readFile(join(recordingsDir, name), 'utf8'))),
  ) as Promise<RecordingMeta[]>;
}

async function readAmplitudeStreams(path: string): Promise<Float64Array[][]> {
  const content = await readFile(path);
  const streams = new Map<number, Float64Array[]>();
  let offset = 0;
  while (offset + 4 <= content.length) {
    const length = content.readUInt32LE(offset);
    offset += 4;
    if (length <= 0 || offset + length > content.length) break;
    const parsed = parseDatagram(content.subarray(offset, offset + length));
    offset += length;
    if (!parsed.ok) continue;
    const deviceId = parsed.datagram.header.deviceId >>> 0;
    const frames = streams.get(deviceId) ?? [];
    for (const frame of parsed.datagram.frames) frames.push(decodeAmplitude(frame));
    streams.set(deviceId, frames);
  }
  return [...streams.values()].map(dominantWidth).filter((frames) => frames.length > 0);
}

function windowsFor(frames: readonly Float64Array[], window: number, step: number): number[][] {
  const rows: number[][] = [];
  for (let start = 0; start + window <= frames.length; start += step) {
    rows.push(windowFeatures(frames.slice(start, start + window)));
  }
  return rows;
}

function dominantWidth(frames: readonly Float64Array[]): Float64Array[] {
  const counts = new Map<number, number>();
  for (const frame of frames) counts.set(frame.length, (counts.get(frame.length) ?? 0) + 1);
  let width = 0;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (candidate > 0 && count > best) {
      width = candidate;
      best = count;
    }
  }
  return frames.filter((frame) => frame.length === width);
}
