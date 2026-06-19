import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeRoomPoint, type RoomGeometry } from './room-geometry.js';
import type { PositionPoint, PositionTarget } from './position-training-types.js';

export type RecordingPosition = PositionPoint & { label: string };
export interface PositionRecordingMeta {
  name: string;
  label: string;
  target?: PositionTarget;
  complete: boolean;
  subjectId?: string;
  subject?: { id?: string; position?: RecordingPosition };
  day?: string;
  movement?: string;
  position?: RecordingPosition;
}

export async function loadPositionMetas(directory: string): Promise<PositionRecordingMeta[]> {
  const names = await readdir(directory);
  return Promise.all(
    names
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))),
  ) as Promise<PositionRecordingMeta[]>;
}

export function recordingPosition(meta: PositionRecordingMeta): RecordingPosition | undefined {
  return meta.position ?? meta.subject?.position;
}

export function recordingSubjectId(meta: PositionRecordingMeta): string {
  return String(meta.subjectId ?? meta.subject?.id ?? '').trim();
}

export function recordingClass(
  meta: PositionRecordingMeta,
  target: PositionTarget,
): string {
  if (target === 'label') return meta.label.trim();
  return isEmptyLabel(meta.label) ? 'empty' : String(recordingPosition(meta)?.label ?? '').trim();
}

export function positionCoordinates(
  label: string,
  meta: PositionRecordingMeta,
  geometry: RoomGeometry | undefined,
): PositionPoint {
  if (isEmptyLabel(label)) return { x: null, y: null };
  const configured = geometry?.zones[label];
  if (configured && geometry) return normalizeRoomPoint(geometry, configured);
  const position = recordingPosition(meta);
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

export function mergePositionCoordinates(
  coordinates: Map<string, PositionPoint>,
  label: string,
  point: PositionPoint,
): void {
  const existing = coordinates.get(label);
  if (
    existing &&
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

export function isEmptyLabel(label: string): boolean {
  return /empty|clear/iu.test(label);
}
