import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PortableModelBundle } from './contracts.js';
import { decodeAmplitude, windowFeatures } from './features.js';
import { parseDatagram } from './protocol.js';

interface RecordingMeta {
  name: string;
  label: string;
  complete: boolean;
  stats?: {
    frames?: number;
  };
}

interface TrainingSummary {
  path: string;
  target: 'label';
  classes: string[];
  recordings: number;
  windows: number;
  window: number;
  trainedAt: string;
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
}): Promise<TrainedDashboardModel> {
  const metas = await loadMetas(options.recordingsDir);
  const featureRows: number[][] = [];
  const labels: string[] = [];
  let recordings = 0;

  for (const meta of metas) {
    if (!meta.complete) continue;
    if (!meta.label || meta.label === 'auto-smoke') continue;
    const frames = dominantWidth(
      await readAmplitudeFrames(join(options.recordingsDir, `${meta.name}.csi.bin`)),
    );
    const rows = windowsFor(frames, options.window, options.step);
    if (rows.length === 0) continue;
    recordings++;
    featureRows.push(...rows);
    labels.push(...Array(rows.length).fill(meta.label));
  }

  const classes = [...new Set(labels)].sort();
  if (classes.length < 2) {
    throw new Error(
      `need at least two recorded labels to train; found ${classes.length ? classes.join(', ') : 'none'}`,
    );
  }
  const width = featureRows[0]?.length ?? 0;
  if (width === 0 || featureRows.some((row) => row.length !== width)) {
    throw new Error('recordings produced inconsistent feature widths');
  }

  const mean = columns(featureRows, (values) => average(values));
  const scale = columns(
    featureRows,
    (values, columnMean) => {
      const variance = average(values.map((value) => (value - columnMean) ** 2));
      const deviation = Math.sqrt(variance);
      return deviation > 1e-12 ? deviation : 1;
    },
    mean,
  );
  const normalized = featureRows.map((row) =>
    row.map((value, index) => (value - mean[index]!) / scale[index]!),
  );
  const prototypes = Object.fromEntries(
    classes.map((label) => {
      const rows = normalized.filter((_row, index) => labels[index] === label);
      return [label, columns(rows, (values) => average(values))];
    }),
  );
  const bundle: PortableModelBundle = {
    format: 'rfsense-portable-model/1',
    target: 'label',
    window: options.window,
    nFeatures: width,
    classes,
    featureMean: mean,
    featureScale: scale,
    prototypes,
    zones: Object.fromEntries(classes.map((label) => [label, { x: null, y: null }])),
    temperature: 1,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    bundle,
    summary: {
      path: options.outPath,
      target: 'label',
      classes,
      recordings,
      windows: featureRows.length,
      window: options.window,
      trainedAt: new Date().toISOString(),
    },
  };
}

async function loadMetas(recordingsDir: string): Promise<RecordingMeta[]> {
  const names = await readdir(recordingsDir);
  const metas = await Promise.all(
    names
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => JSON.parse(await readFile(join(recordingsDir, name), 'utf8'))),
  );
  return metas as RecordingMeta[];
}

async function readAmplitudeFrames(path: string): Promise<Float64Array[]> {
  const content = await readFile(path);
  const frames: Float64Array[] = [];
  let offset = 0;
  while (offset + 4 <= content.length) {
    const length = content.readUInt32LE(offset);
    offset += 4;
    if (length <= 0 || offset + length > content.length) break;
    const parsed = parseDatagram(content.subarray(offset, offset + length));
    offset += length;
    if (!parsed.ok) continue;
    for (const frame of parsed.datagram.frames) frames.push(decodeAmplitude(frame));
  }
  return frames;
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

function columns(
  rows: readonly number[][],
  reduce: (values: number[], mean: number) => number,
  means?: readonly number[],
): number[] {
  const width = rows[0]?.length ?? 0;
  return Array.from({ length: width }, (_unused, column) => {
    const values = rows.map((row) => row[column]!);
    return reduce(values, means?.[column] ?? average(values));
  });
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
