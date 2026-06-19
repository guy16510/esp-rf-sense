import { join } from 'node:path';

import type { TrainingExample } from './prototype-training.js';
import {
  isEmptyLabel,
  loadPositionMetas,
  mergePositionCoordinates,
  positionCoordinates,
  recordingClass,
  recordingPosition,
  recordingSubjectId,
} from './position-recording-meta.js';
import { readReceiverWindows } from './position-streams.js';
import type { PositionPoint, PositionTarget } from './position-training-types.js';
import type { RoomGeometry } from './room-geometry.js';

export interface PositionTrainingData {
  examples: TrainingExample[];
  coordinates: Map<string, PositionPoint>;
  recordingsByClass: Map<string, Set<string>>;
  incompleteMetadata: string[];
}

export async function loadPositionTrainingData(options: {
  recordingsDir: string;
  window: number;
  step: number;
  target: PositionTarget;
  geometry?: RoomGeometry;
}): Promise<PositionTrainingData> {
  const examples: TrainingExample[] = [];
  const coordinates = new Map<string, PositionPoint>();
  const recordingsByClass = new Map<string, Set<string>>();
  const incompleteMetadata: string[] = [];

  for (const meta of await loadPositionMetas(options.recordingsDir)) {
    if (!meta.complete || meta.label === 'auto-smoke') continue;
    if (meta.target && meta.target !== options.target) continue;
    const position = recordingPosition(meta);
    const subjectId = recordingSubjectId(meta);
    const label = recordingClass(meta, options.target);
    if (!label) {
      incompleteMetadata.push(`${meta.name} (position label)`);
      continue;
    }
    if (options.target === 'position' && !String(meta.day ?? '').trim()) {
      incompleteMetadata.push(`${meta.name} (day)`);
      continue;
    }
    if (options.target === 'position' && !isEmptyLabel(meta.label) && !subjectId) {
      incompleteMetadata.push(`${meta.name} (subject ID)`);
      continue;
    }

    const rows = await readReceiverWindows(
      join(options.recordingsDir, `${meta.name}.jsonl`),
      options.window,
      options.step,
    );
    if (rows.length === 0) continue;
    if (options.target === 'position') {
      mergePositionCoordinates(
        coordinates,
        label,
        positionCoordinates(label, meta, options.geometry),
      );
    }
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
        position: String(position?.label ?? (isEmptyLabel(meta.label) ? 'empty' : '')),
      });
    }
  }
  return { examples, coordinates, recordingsByClass, incompleteMetadata };
}
