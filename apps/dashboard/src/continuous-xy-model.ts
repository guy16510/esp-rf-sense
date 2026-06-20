import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CONTINUOUS_XY_MODEL_FORMAT = 'rfsense-continuous-xy-model/2';

export interface ContinuousXYTarget {
  xMeters: number;
  yMeters: number;
}

export interface ContinuousXYExample extends ContinuousXYTarget {
  features: number[];
  recordingId: string;
  subjectId: string;
  day: string;
  orientationDegrees: number;
  movement: string;
  receiverCount: number;
  packetOverlap: number;
  empty: boolean;
}

export interface ContinuousXYValidation {
  validatedContinuousXY: boolean;
  generatedAt: string;
  medianAcceptedErrorMeters: number | null;
  p90AcceptedErrorMeters: number | null;
  acceptedCoverage: number | null;
  emptyRoomFalseAcceptanceRate: number | null;
  outOfDistributionRejectionRate: number | null;
  threeReceiverAcceptedRate: number | null;
  stationaryJitterP90Meters: number | null;
  endToEndLatencyMs: number | null;
  artifactPath?: string | null;
  fixtureHash?: string | null;
  passed: boolean;
}

export interface ContinuousXYModel {
  format: typeof CONTINUOUS_XY_MODEL_FORMAT;
  modelTarget: 'continuous-xy';
  featureVersion: number;
  room: {
    widthMeters: number;
    heightMeters: number;
  };
  examples: ContinuousXYExample[];
  emptyExamples: ContinuousXYExample[];
  featureMean: number[];
  featureScale: number[];
  neighborCount: number;
  densityThreshold: number;
  uncertaintyThresholdMeters: number;
  emptyDistanceThreshold: number | null;
  validation: ContinuousXYValidation;
  trainedAt: string;
}

export interface ContinuousXYInput {
  features: number[];
  receiverCount: number;
  packetOverlap: number;
  empty?: boolean;
  latencyMs?: number;
}

export interface ContinuousXYPrediction {
  accepted: boolean;
  xMeters: number | null;
  yMeters: number | null;
  xNormalized: number | null;
  yNormalized: number | null;
  uncertaintyMeters: number | null;
  confidence: number;
  receiverCount: number;
  packetOverlap: number;
  reason: string | null;
  nearestDistance: number | null;
}

export function trainContinuousXYModel(options: {
  examples: ContinuousXYExample[];
  roomWidthMeters: number;
  roomHeightMeters: number;
  featureVersion: number;
  validation?: Partial<ContinuousXYValidation>;
}): ContinuousXYModel {
  const occupied = options.examples.filter((example) => !example.empty && example.receiverCount >= 3);
  const emptyExamples = options.examples.filter((example) => example.empty);
  if (occupied.length < 8) throw new Error('continuous XY training requires at least eight occupied examples');
  const width = occupied[0]?.features.length ?? 0;
  if (width === 0 || options.examples.some((example) => example.features.length !== width)) {
    throw new Error('continuous XY examples have inconsistent feature widths');
  }
  if (!Number.isFinite(options.roomWidthMeters) || options.roomWidthMeters <= 0) {
    throw new Error('roomWidthMeters must be positive');
  }
  if (!Number.isFinite(options.roomHeightMeters) || options.roomHeightMeters <= 0) {
    throw new Error('roomHeightMeters must be positive');
  }
  for (const example of occupied) {
    if (
      !Number.isFinite(example.xMeters) ||
      !Number.isFinite(example.yMeters) ||
      example.xMeters < 0 ||
      example.xMeters > options.roomWidthMeters ||
      example.yMeters < 0 ||
      example.yMeters > options.roomHeightMeters
    ) {
      throw new Error(`continuous XY target is outside room bounds for ${example.recordingId}`);
    }
  }

  const featureMean = columns(occupied.map((example) => example.features), average);
  const featureScale = columns(occupied.map((example) => example.features), (values, mean) => {
    const dev = Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
    return dev > 1e-12 ? dev : 1;
  }, featureMean);
  const normalizedOccupied = occupied.map((example) => normalize(example.features, featureMean, featureScale));
  const nearestDistances = normalizedOccupied.map((row, index) =>
    Math.sqrt(
      Math.min(
        ...normalizedOccupied.map((other, otherIndex) =>
          otherIndex === index ? Number.POSITIVE_INFINITY : squaredDistance(row, other),
        ),
      ),
    ),
  );
  const normalizedEmpty = emptyExamples.map((example) => normalize(example.features, featureMean, featureScale));
  const emptyDistances = normalizedEmpty.map((row) =>
    Math.sqrt(Math.min(...normalizedOccupied.map((other) => squaredDistance(row, other)))),
  );
  const fallbackValidation: ContinuousXYValidation = {
    validatedContinuousXY: false,
    generatedAt: new Date().toISOString(),
    medianAcceptedErrorMeters: null,
    p90AcceptedErrorMeters: null,
    acceptedCoverage: null,
    emptyRoomFalseAcceptanceRate: null,
    outOfDistributionRejectionRate: null,
    threeReceiverAcceptedRate: null,
    stationaryJitterP90Meters: null,
    endToEndLatencyMs: null,
    passed: false,
  };
  return {
    format: CONTINUOUS_XY_MODEL_FORMAT,
    modelTarget: 'continuous-xy',
    featureVersion: options.featureVersion,
    room: {
      widthMeters: options.roomWidthMeters,
      heightMeters: options.roomHeightMeters,
    },
    examples: occupied,
    emptyExamples,
    featureMean,
    featureScale,
    neighborCount: 8,
    densityThreshold: Math.max(0.1, quantile(nearestDistances, 0.99) * 2),
    uncertaintyThresholdMeters: 0.75,
    emptyDistanceThreshold:
      emptyDistances.length > 0 ? Math.max(0.1, quantile(emptyDistances, 0.05) * 0.85) : null,
    validation: { ...fallbackValidation, ...options.validation, passed: options.validation?.passed ?? false },
    trainedAt: new Date().toISOString(),
  };
}

export function predictContinuousXY(
  model: ContinuousXYModel,
  input: ContinuousXYInput,
): ContinuousXYPrediction {
  if (input.receiverCount < 3) return rejected(input, 'insufficient-receivers');
  if (input.packetOverlap < 0.75) return rejected(input, 'insufficient-packet-overlap');
  if (input.empty) return rejected(input, 'empty-room');
  if (input.features.length !== model.featureMean.length) return rejected(input, 'feature-width-mismatch');

  const row = normalize(input.features, model.featureMean, model.featureScale);
  const nearestEmptyDistance =
    model.emptyExamples.length > 0
      ? Math.sqrt(
          Math.min(
            ...model.emptyExamples.map((example) =>
              squaredDistance(row, normalize(example.features, model.featureMean, model.featureScale)),
            ),
          ),
        )
      : Number.POSITIVE_INFINITY;
  if (
    model.emptyDistanceThreshold !== null &&
    Number.isFinite(nearestEmptyDistance) &&
    nearestEmptyDistance <= model.emptyDistanceThreshold
  ) {
    return rejected(input, 'empty-room');
  }

  const neighbors = model.examples
    .map((example) => ({
      example,
      distance: Math.sqrt(squaredDistance(row, normalize(example.features, model.featureMean, model.featureScale))),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, model.neighborCount);
  const nearest = neighbors[0]?.distance ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(nearest) || nearest > model.densityThreshold) {
    return rejected(input, 'outside-calibrated-distribution', nearest);
  }

  const weights = neighbors.map((neighbor) => 1 / Math.max(1e-6, neighbor.distance ** 2));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const xMeters =
    neighbors.reduce((sum, neighbor, index) => sum + neighbor.example.xMeters * weights[index]!, 0) /
    weightSum;
  const yMeters =
    neighbors.reduce((sum, neighbor, index) => sum + neighbor.example.yMeters * weights[index]!, 0) /
    weightSum;
  const disagreement = Math.sqrt(
    neighbors.reduce((sum, neighbor, index) => {
      const dx = neighbor.example.xMeters - xMeters;
      const dy = neighbor.example.yMeters - yMeters;
      return sum + weights[index]! * (dx * dx + dy * dy);
    }, 0) / weightSum,
  );
  const receiverPenalty = input.receiverCount < 4 ? 0.15 : 0;
  const overlapPenalty = Math.max(0, 0.95 - input.packetOverlap) * 0.6;
  const uncertaintyMeters = Math.max(0.08, disagreement + nearest * 0.12 + receiverPenalty + overlapPenalty);
  const confidence = clamp(1 - uncertaintyMeters / Math.max(model.uncertaintyThresholdMeters * 1.5, 1e-6));

  if (uncertaintyMeters > model.uncertaintyThresholdMeters) {
    return {
      accepted: false,
      xMeters: null,
      yMeters: null,
      xNormalized: null,
      yNormalized: null,
      uncertaintyMeters,
      confidence,
      receiverCount: input.receiverCount,
      packetOverlap: input.packetOverlap,
      reason: 'high-uncertainty',
      nearestDistance: nearest,
    };
  }
  return {
    accepted: true,
    xMeters,
    yMeters,
    xNormalized: clamp(xMeters / model.room.widthMeters),
    yNormalized: clamp(yMeters / model.room.heightMeters),
    uncertaintyMeters,
    confidence,
    receiverCount: input.receiverCount,
    packetOverlap: input.packetOverlap,
    reason: null,
    nearestDistance: nearest,
  };
}

export async function loadContinuousXYModel(path: string): Promise<ContinuousXYModel> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ContinuousXYModel>;
  if (parsed.format !== CONTINUOUS_XY_MODEL_FORMAT) throw new Error(`unsupported continuous XY model format in ${path}`);
  if (parsed.modelTarget !== 'continuous-xy') throw new Error('continuous XY model target is invalid');
  if (!parsed.room || !Number.isFinite(parsed.room.widthMeters) || !Number.isFinite(parsed.room.heightMeters)) {
    throw new Error('continuous XY model room dimensions are missing');
  }
  if (!Array.isArray(parsed.featureMean) || !Array.isArray(parsed.featureScale)) {
    throw new Error('continuous XY model normalization is missing');
  }
  if (parsed.featureMean.length === 0 || parsed.featureMean.length !== parsed.featureScale.length) {
    throw new Error('continuous XY model normalization width mismatch');
  }
  if (!Array.isArray(parsed.examples) || parsed.examples.length < 8) {
    throw new Error('continuous XY model requires at least eight occupied examples');
  }
  if (
    parsed.examples.some(
      (example) => !Array.isArray(example.features) || example.features.length !== parsed.featureMean!.length,
    )
  ) {
    throw new Error('continuous XY model feature width mismatch');
  }
  if (!Number.isFinite(parsed.densityThreshold) || !Number.isFinite(parsed.uncertaintyThresholdMeters)) {
    throw new Error('continuous XY model thresholds are invalid');
  }
  return parsed as ContinuousXYModel;
}

export async function saveContinuousXYModel(path: string, model: ContinuousXYModel): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
}

function rejected(input: ContinuousXYInput, reason: string, nearestDistance: number | null = null): ContinuousXYPrediction {
  return {
    accepted: false,
    xMeters: null,
    yMeters: null,
    xNormalized: null,
    yNormalized: null,
    uncertaintyMeters: null,
    confidence: 0,
    receiverCount: input.receiverCount,
    packetOverlap: input.packetOverlap,
    reason,
    nearestDistance,
  };
}

function normalize(values: readonly number[], mean: readonly number[], scale: readonly number[]): number[] {
  return mean.map((item, index) => (values[index]! - item) / (Math.abs(scale[index] ?? 1) > 1e-12 ? scale[index]! : 1));
}

function squaredDistance(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index]! - right[index]!) ** 2;
  }
  return total / Math.max(1, left.length);
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

function quantile(values: readonly number[], amount: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(amount * (sorted.length - 1))))] ?? 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
