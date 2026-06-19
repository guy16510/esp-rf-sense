import type { ModelValidationReport, ValidationMetric } from './contracts.js';

export interface TrainingExample {
  features: number[];
  label: string;
  recordingId: string;
  subjectId: string;
  day: string;
  position: string;
}

export interface FittedPrototype {
  classes: string[];
  mean: number[];
  scale: number[];
  prototypes: Record<string, number[]>;
  temperature: number;
  confidenceThreshold: number;
  marginThreshold: number;
  distanceThreshold: number;
}

export function fitPrototype(examples: TrainingExample[]): FittedPrototype {
  const rows = examples.map((example) => example.features);
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('recordings produced inconsistent feature widths');
  }
  const mean = columns(rows, (values) => average(values));
  const scale = columns(
    rows,
    (values, columnMean) => {
      const variance = average(values.map((value) => (value - columnMean) ** 2));
      const deviation = Math.sqrt(variance);
      return deviation > 1e-12 ? deviation : 1;
    },
    mean,
  );
  const normalized = rows.map((row) =>
    row.map((value, index) => (value - mean[index]!) / scale[index]!),
  );
  const classes = [...new Set(examples.map((example) => example.label))].sort();
  const prototypes = Object.fromEntries(
    classes.map((label) => {
      const classRows = normalized.filter((_row, index) => examples[index]?.label === label);
      return [label, columns(classRows, (values) => average(values))];
    }),
  );
  const ownDistances = normalized.map((row, index) =>
    squaredDistance(row, prototypes[examples[index]!.label]!),
  );
  const margins = normalized.map((row) => nearestMargin(classes, prototypes, row));
  return {
    classes,
    mean,
    scale,
    prototypes,
    temperature: Math.max(0.05, quantile(ownDistances, 0.5)),
    confidenceThreshold: 0.58,
    marginThreshold: Math.max(0.05, quantile(margins, 0.1) * 0.5),
    distanceThreshold: Math.max(0.01, quantile(ownDistances, 0.98) * 1.25),
  };
}

export function validateExamples(examples: TrainingExample[]): ModelValidationReport {
  const metrics: ValidationMetric[] = [
    classificationHoldout(examples, 'recordingId', 'leave-one-recording-out'),
    classificationHoldout(examples, 'subjectId', 'leave-one-person-out'),
    classificationHoldout(examples, 'day', 'leave-one-day-out'),
    positionHoldout(examples),
  ];
  const warnings = metrics
    .filter((metric) => metric.status === 'not-applicable' || metric.status === 'fail')
    .map((metric) => metric.note);
  return { leakageSafe: true, generatedAt: new Date().toISOString(), metrics, warnings };
}

export function predictPrototype(
  model: FittedPrototype,
  row: readonly number[],
): { label: string; accepted: boolean; confidence: number; margin: number; distance: number } {
  const normalized = model.mean.map((mean, index) => {
    const value = row[index] ?? mean;
    return (value - mean) / model.scale[index]!;
  });
  const distances = model.classes
    .map((label) => ({ label, distance: squaredDistance(normalized, model.prototypes[label]!) }))
    .sort((left, right) => left.distance - right.distance);
  const winner = distances[0]!;
  const second = distances[1]?.distance ?? winner.distance;
  const margin = second > 1e-12 ? Math.max(0, (second - winner.distance) / second) : 0;
  const weights = distances.map((item) =>
    Math.exp(-(item.distance - winner.distance) / Math.max(model.temperature, 1e-6)),
  );
  const confidence = (weights[0] ?? 0) / (weights.reduce((sum, value) => sum + value, 0) || 1);
  return {
    label: winner.label,
    accepted:
      confidence >= model.confidenceThreshold &&
      margin >= model.marginThreshold &&
      winner.distance <= model.distanceThreshold,
    confidence,
    margin,
    distance: winner.distance,
  };
}

function classificationHoldout(
  examples: TrainingExample[],
  key: 'recordingId' | 'subjectId' | 'day',
  protocol: ValidationMetric['protocol'],
): ValidationMetric {
  const groups = [...new Set(examples.map((example) => example[key]).filter(Boolean))];
  if (groups.length < 2) return unavailable(protocol, `${protocol} needs at least two groups`);
  let correct = 0;
  let samples = 0;
  let folds = 0;
  for (const group of groups) {
    const train = examples.filter((example) => example[key] !== group);
    const known = new Set(train.map((example) => example.label));
    const test = examples.filter((example) => example[key] === group && known.has(example.label));
    if (test.length === 0 || known.size < 2) continue;
    const model = fitPrototype(train);
    folds++;
    for (const example of test) {
      if (predictPrototype(model, example.features).label === example.label) correct++;
      samples++;
    }
  }
  if (folds === 0 || samples === 0) {
    return unavailable(protocol, `${protocol} had no usable folds with known test classes`);
  }
  const accuracy = correct / samples;
  return {
    protocol,
    status: accuracy >= 0.6 ? 'pass' : 'fail',
    folds,
    samples,
    accuracy,
    unknownRejection: null,
    note:
      accuracy >= 0.6
        ? 'Whole recordings remain grouped; no adjacent windows leak into training.'
        : `${protocol} accuracy was ${(accuracy * 100).toFixed(1)}%, below the 60% gate`,
  };
}

function positionHoldout(examples: TrainingExample[]): ValidationMetric {
  const positions = [
    ...new Set(
      examples
        .map((example) => example.position)
        .filter((value) => value && !/empty|clear/iu.test(value)),
    ),
  ];
  if (positions.length < 2) {
    return unavailable('leave-one-position-out', 'leave-one-position-out needs two occupied zones');
  }
  let rejected = 0;
  let samples = 0;
  let folds = 0;
  for (const position of positions) {
    const train = examples.filter((example) => example.position !== position);
    const test = examples.filter((example) => example.position === position);
    if (test.length === 0 || new Set(train.map((example) => example.label)).size < 2) continue;
    const model = fitPrototype(train);
    folds++;
    for (const example of test) {
      if (!predictPrototype(model, example.features).accepted) rejected++;
      samples++;
    }
  }
  return {
    protocol: 'leave-one-position-out',
    status: 'diagnostic',
    folds,
    samples,
    accuracy: null,
    unknownRejection: samples > 0 ? rejected / samples : null,
    note:
      'A removed zone cannot be named by a classifier that never saw it. This reports unseen-zone rejection instead of fake localization accuracy.',
  };
}

function unavailable(protocol: ValidationMetric['protocol'], note: string): ValidationMetric {
  return {
    protocol,
    status: 'not-applicable',
    folds: 0,
    samples: 0,
    accuracy: null,
    unknownRejection: null,
    note,
  };
}

function nearestMargin(
  classes: readonly string[],
  prototypes: Record<string, number[]>,
  row: readonly number[],
): number {
  const distances = classes
    .map((label) => squaredDistance(row, prototypes[label]!))
    .sort((left, right) => left - right);
  const nearest = distances[0] ?? 0;
  const second = distances[1] ?? nearest;
  return second > 1e-12 ? Math.max(0, (second - nearest) / second) : 0;
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

function squaredDistance(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    total += delta * delta;
  }
  return total / Math.max(1, left.length);
}

function quantile(values: readonly number[], amount: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(amount * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
