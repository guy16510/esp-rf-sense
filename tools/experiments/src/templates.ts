// Initial experiment group templates. Each fills in sensible defaults for one kind of session;
// the runner overlays per-session specifics (subjectIds, day, positions). These map directly to
// the evaluation questions: empty-vs-occupied, moving-vs-stationary, position, people-count.
import type { ExperimentMetadata, Movement } from './metadata.js';

export interface GroupTemplate {
  group: string;
  description: string;
  label: string;
  defaults: {
    captureMode: ExperimentMetadata['captureMode'];
    movement: Movement;
    subjectCount: number;
  };
}

export const TEMPLATES: Record<string, GroupTemplate> = {
  'empty-baseline': {
    group: 'empty-baseline',
    description: 'Empty room reference. Establishes the no-subject CSI baseline.',
    label: 'empty',
    defaults: { captureMode: 'controlled', movement: 'none', subjectCount: 0 },
  },
  moving: {
    group: 'moving',
    description: 'One subject walking through the link. Tests motion detection / Doppler.',
    label: 'occupied-moving',
    defaults: { captureMode: 'controlled', movement: 'walking', subjectCount: 1 },
  },
  stationary: {
    group: 'stationary',
    description: 'One subject standing still. Tests presence vs. an empty room (the hard case).',
    label: 'occupied-stationary',
    defaults: { captureMode: 'controlled', movement: 'stationary', subjectCount: 1 },
  },
  'position-grid': {
    group: 'position-grid',
    description:
      'One subject at labeled grid positions. Tests coarse localization across the link.',
    label: 'occupied-positioned',
    defaults: { captureMode: 'controlled', movement: 'stationary', subjectCount: 1 },
  },
  'multi-person': {
    group: 'multi-person',
    description: 'Two or more subjects. Tests how far people-counting can be pushed on one link.',
    label: 'occupied-multi',
    defaults: { captureMode: 'controlled', movement: 'mixed', subjectCount: 2 },
  },
};

export function listTemplates(): string {
  return Object.values(TEMPLATES)
    .map((t) => `  ${t.group.padEnd(16)} ${t.description}`)
    .join('\n');
}
