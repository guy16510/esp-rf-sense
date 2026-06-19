import { readFile } from 'node:fs/promises';

import type { PortableModelBundle } from './contracts.js';

export interface ModelPrediction {
  state: string;
  confidence: number;
  scores: Record<string, number>;
  zone: string | null;
  accepted: boolean;
  margin: number;
  distance: number;
  reason: string | null;
}

export class PortablePrototypeModel {
  constructor(readonly bundle: PortableModelBundle) {}

  predict(features: readonly number[]): ModelPrediction {
    const aligned = Array.from({ length: this.bundle.nFeatures }, (_unused, index) =>
      index < features.length ? features[index]! : (this.bundle.featureMean[index] ?? 0),
    );
    const normalized = aligned.map((value, index) => {
      const mean = this.bundle.featureMean[index] ?? 0;
      const scale = this.bundle.featureScale[index] ?? 1;
      return (value - mean) / (Math.abs(scale) > 1e-12 ? scale : 1);
    });

    const distances = this.bundle.classes
      .map((label) => {
        const prototype = this.bundle.prototypes[label];
        if (!prototype || prototype.length !== normalized.length) {
          throw new Error(`model prototype for "${label}" is missing or has the wrong length`);
        }
        let distance = 0;
        for (let index = 0; index < normalized.length; index++) {
          const delta = normalized[index]! - prototype[index]!;
          distance += delta * delta;
        }
        return { label, distance: distance / normalized.length };
      })
      .sort((left, right) => left.distance - right.distance);
    const minimum = distances[0]?.distance ?? Number.POSITIVE_INFINITY;
    const temperature = Math.max(this.bundle.temperature ?? 1, 1e-6);
    const weights = distances.map((item) => ({
      label: item.label,
      weight: Math.exp(-(item.distance - minimum) / temperature),
    }));
    const total = weights.reduce((sum, item) => sum + item.weight, 0) || 1;
    const scores = Object.fromEntries(weights.map((item) => [item.label, item.weight / total]));
    const winner = distances[0]!;
    const confidence = scores[winner.label] ?? 0;
    const secondDistance = distances[1]?.distance ?? winner.distance;
    const margin =
      secondDistance > 1e-12 ? Math.max(0, (secondDistance - winner.distance) / secondDistance) : 0;
    const confidenceThreshold = this.bundle.confidenceThreshold ?? 0.58;
    const marginThreshold = this.bundle.marginThreshold ?? 0.08;
    const distanceThreshold = this.bundle.distanceThreshold ?? Number.POSITIVE_INFINITY;
    const failures: string[] = [];
    if (confidence < confidenceThreshold) failures.push('confidence below model threshold');
    if (margin < marginThreshold) failures.push('top zones are too close');
    if (winner.distance > distanceThreshold) failures.push('sample is outside the trained distribution');
    const accepted = failures.length === 0;
    const zone = this.bundle.target === 'position' && accepted ? winner.label : null;
    return {
      state: winner.label,
      confidence,
      scores,
      zone,
      accepted,
      margin,
      distance: winner.distance,
      reason: accepted ? null : failures.join('; '),
    };
  }
}

export async function loadPortableModel(path: string): Promise<PortablePrototypeModel> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PortableModelBundle>;
  if (parsed.format !== 'rfsense-portable-model/1') {
    throw new Error(`unsupported model format in ${path}`);
  }
  if (!Array.isArray(parsed.classes) || parsed.classes.length < 2) {
    throw new Error('portable model requires at least two classes');
  }
  if (!Array.isArray(parsed.featureMean) || !Array.isArray(parsed.featureScale)) {
    throw new Error('portable model is missing feature normalization arrays');
  }
  if (!parsed.prototypes || !parsed.zones || !parsed.target) {
    throw new Error('portable model is incomplete');
  }
  if (!Number.isInteger(parsed.window) || !Number.isInteger(parsed.nFeatures)) {
    throw new Error('portable model window and nFeatures must be integers');
  }
  if (parsed.target === 'position') {
    const missingZones = parsed.classes.filter(
      (label) =>
        !/empty|clear/iu.test(label) &&
        (parsed.zones?.[label]?.x === null || parsed.zones?.[label]?.y === null),
    );
    if (missingZones.length > 0) {
      throw new Error(`position model is missing coordinates for: ${missingZones.join(', ')}`);
    }
  }
  return new PortablePrototypeModel(parsed as PortableModelBundle);
}
