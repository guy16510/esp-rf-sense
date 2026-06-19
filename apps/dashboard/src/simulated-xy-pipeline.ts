import type { ReceiverSlot } from './joint-packet-aligner.js';

export interface XYPoint { xMeters: number; yMeters: number }
export interface XYTrainingExample extends XYPoint {
  features: number[];
  recordingId: string;
  subjectId: string;
  day: string;
  orientationDegrees: number;
  receiverCount: number;
  packetOverlap: number;
  empty: boolean;
}
export interface XYPrediction extends XYPoint {
  uncertaintyMeters: number;
  accepted: boolean;
  rejectionReason: string | null;
  receiverCount: number;
  packetOverlap: number;
}
export interface XYModel {
  examples: XYTrainingExample[];
  featureMean: number[];
  featureScale: number[];
  densityThreshold: number;
  uncertaintyThreshold: number;
}
export interface ValidationSummary {
  medianErrorMeters: number;
  p90ErrorMeters: number;
  acceptedCoverage: number;
  falseAcceptedEmptyRate: number;
  oodRejectionRate: number;
  threeReceiverAcceptedRate: number;
  passed: boolean;
}

const receiverPositions: Record<ReceiverSlot, XYPoint> = {
  A: { xMeters: 0, yMeters: 0 },
  B: { xMeters: 4, yMeters: 0 },
  C: { xMeters: 0, yMeters: 4 },
  D: { xMeters: 4, yMeters: 4 },
};
const slots: ReceiverSlot[] = ['A', 'B', 'C', 'D'];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function simulateFourReceiverExample(
  point: XYPoint,
  seed: number,
  metadata: Partial<Omit<XYTrainingExample, keyof XYPoint | 'features'>> = {},
): XYTrainingExample {
  const rng = seeded(seed);
  const missing = metadata.receiverCount === 3 ? seed % 4 : -1;
  const receiverFeatures = slots.flatMap((slot, index) => {
    if (index === missing) return [0, 0, 0, 0, 0];
    const receiver = receiverPositions[slot];
    const dx = point.xMeters - receiver.xMeters;
    const dy = point.yMeters - receiver.yMeters;
    const distance = Math.hypot(dx, dy) + 0.15;
    return [
      -34 - 17 * Math.log10(distance) + gaussian(rng) * 0.35,
      1 / distance + gaussian(rng) * 0.008,
      dx / (distance * distance) + gaussian(rng) * 0.004,
      dy / (distance * distance) + gaussian(rng) * 0.004,
      1,
    ];
  });
  const rssi = slots.map((_slot, index) => receiverFeatures[index * 5] ?? 0);
  const cross = [
    rssi[0]! - rssi[1]!, rssi[0]! - rssi[2]!, rssi[0]! - rssi[3]!,
    rssi[1]! - rssi[2]!, rssi[1]! - rssi[3]!, rssi[2]! - rssi[3]!,
  ];
  return {
    xMeters: point.xMeters,
    yMeters: point.yMeters,
    features: [...receiverFeatures, ...cross],
    recordingId: metadata.recordingId ?? `recording-${seed}`,
    subjectId: metadata.subjectId ?? `person-${seed % 2}`,
    day: metadata.day ?? `2026-06-${19 + (seed % 3)}`,
    orientationDegrees: metadata.orientationDegrees ?? (seed % 4) * 90,
    receiverCount: metadata.receiverCount ?? 4,
    packetOverlap: metadata.packetOverlap ?? 0.96,
    empty: metadata.empty ?? false,
  };
}

export function buildSyntheticDataset(): XYTrainingExample[] {
  const examples: XYTrainingExample[] = [];
  let seed = 1;
  for (let x = 0.5; x <= 3.5; x += 0.5) {
    for (let y = 0.5; y <= 3.5; y += 0.5) {
      for (let repeat = 0; repeat < 12; repeat += 1) {
        examples.push(simulateFourReceiverExample({ xMeters: x, yMeters: y }, seed, {
          recordingId: `cell-${x}-${y}-recording-${repeat % 3}`,
          subjectId: `person-${repeat % 2}`,
          day: `2026-06-${19 + (repeat % 3)}`,
          orientationDegrees: (repeat % 4) * 90,
          receiverCount: repeat % 10 === 0 ? 3 : 4,
          packetOverlap: repeat % 10 === 0 ? 0.86 : 0.96,
        }));
        seed += 1;
      }
    }
  }
  return examples;
}

export function trainXYModel(examples: XYTrainingExample[]): XYModel {
  const occupied = examples.filter((example) => !example.empty && example.receiverCount >= 3);
  if (occupied.length < 20) throw new Error('insufficient joint XY training examples');
  const width = occupied[0]!.features.length;
  if (occupied.some((example) => example.features.length !== width)) throw new Error('feature width mismatch');
  const featureMean = Array.from({ length: width }, (_, column) => average(occupied.map((item) => item.features[column]!)));
  const featureScale = Array.from({ length: width }, (_, column) => {
    const variance = average(occupied.map((item) => (item.features[column]! - featureMean[column]!) ** 2));
    return Math.sqrt(variance) || 1;
  });
  const normalized = occupied.map((example) => normalize(example.features, featureMean, featureScale));
  const nearestDistances = normalized.map((row, index) => Math.sqrt(Math.min(...normalized.map((other, otherIndex) => otherIndex === index ? Infinity : squaredDistance(row, other)))));
  return {
    examples: occupied,
    featureMean,
    featureScale,
    densityThreshold: quantile(nearestDistances, 0.99) * 2,
    uncertaintyThreshold: 0.75,
  };
}

export function predictXY(model: XYModel, example: XYTrainingExample): XYPrediction {
  if (example.receiverCount < 3) return rejected(example, 'insufficient-receivers');
  if (example.packetOverlap < 0.75) return rejected(example, 'insufficient-packet-overlap');
  if (example.empty) return rejected(example, 'empty-room');
  const row = normalize(example.features, model.featureMean, model.featureScale);
  const neighbors = model.examples
    .map((training) => ({ training, distance: Math.sqrt(squaredDistance(row, normalize(training.features, model.featureMean, model.featureScale))) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 8);
  const nearest = neighbors[0]?.distance ?? Infinity;
  if (!Number.isFinite(nearest) || nearest > model.densityThreshold) return rejected(example, 'outside-calibrated-area');
  const weights = neighbors.map((neighbor) => 1 / Math.max(1e-6, neighbor.distance ** 2));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const xMeters = neighbors.reduce((sum, neighbor, index) => sum + neighbor.training.xMeters * weights[index]!, 0) / weightSum;
  const yMeters = neighbors.reduce((sum, neighbor, index) => sum + neighbor.training.yMeters * weights[index]!, 0) / weightSum;
  const disagreement = Math.sqrt(neighbors.reduce((sum, neighbor, index) => {
    const dx = neighbor.training.xMeters - xMeters;
    const dy = neighbor.training.yMeters - yMeters;
    return sum + weights[index]! * (dx * dx + dy * dy);
  }, 0) / weightSum);
  const uncertaintyMeters = Math.max(0.08, disagreement + nearest * 0.12);
  if (uncertaintyMeters > model.uncertaintyThreshold) {
    return { xMeters, yMeters, uncertaintyMeters, accepted: false, rejectionReason: 'high-uncertainty', receiverCount: example.receiverCount, packetOverlap: example.packetOverlap };
  }
  return { xMeters, yMeters, uncertaintyMeters, accepted: true, rejectionReason: null, receiverCount: example.receiverCount, packetOverlap: example.packetOverlap };
}

export function validateSyntheticXY(model: XYModel): ValidationSummary {
  const heldOut: XYTrainingExample[] = [];
  let seed = 50000;
  for (let x = 0.65; x <= 3.35; x += 0.45) {
    for (let y = 0.65; y <= 3.35; y += 0.45) {
      heldOut.push(simulateFourReceiverExample({ xMeters: x, yMeters: y }, seed++, {
        recordingId: `held-${seed}`,
        subjectId: 'person-held-out',
        day: '2026-06-25',
        orientationDegrees: 45,
        receiverCount: seed % 5 === 0 ? 3 : 4,
        packetOverlap: 0.92,
      }));
    }
  }
  const predictions = heldOut.map((example) => ({ example, prediction: predictXY(model, example) }));
  const accepted = predictions.filter((item) => item.prediction.accepted);
  const errors = accepted.map(({ example, prediction }) => Math.hypot(prediction.xMeters - example.xMeters, prediction.yMeters - example.yMeters));
  const empty = Array.from({ length: 100 }, (_, index) => simulateFourReceiverExample({ xMeters: 2, yMeters: 2 }, 70000 + index, { empty: true }));
  const ood = Array.from({ length: 100 }, (_, index) => simulateFourReceiverExample({ xMeters: 8 + index / 50, yMeters: 8 }, 80000 + index));
  const summary = {
    medianErrorMeters: quantile(errors, 0.5),
    p90ErrorMeters: quantile(errors, 0.9),
    acceptedCoverage: accepted.length / heldOut.length,
    falseAcceptedEmptyRate: empty.filter((example) => predictXY(model, example).accepted).length / empty.length,
    oodRejectionRate: ood.filter((example) => !predictXY(model, example).accepted).length / ood.length,
    threeReceiverAcceptedRate: accepted.filter((item) => item.example.receiverCount >= 3).length / Math.max(1, accepted.length),
    passed: false,
  };
  summary.passed = summary.medianErrorMeters <= 0.75 && summary.p90ErrorMeters <= 1.5 && summary.falseAcceptedEmptyRate <= 0.05 && summary.oodRejectionRate >= 0.9 && summary.threeReceiverAcceptedRate >= 0.95;
  return summary;
}

function rejected(example: XYTrainingExample, rejectionReason: string): XYPrediction {
  return { xMeters: 0, yMeters: 0, uncertaintyMeters: Infinity, accepted: false, rejectionReason, receiverCount: example.receiverCount, packetOverlap: example.packetOverlap };
}
function normalize(values: number[], mean: number[], scale: number[]): number[] { return values.map((value, index) => (value - mean[index]!) / scale[index]!); }
function squaredDistance(left: number[], right: number[]): number { return average(left.map((value, index) => (value - right[index]!) ** 2)); }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function quantile(values: number[], amount: number): number {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(amount * (sorted.length - 1)))]!;
}
