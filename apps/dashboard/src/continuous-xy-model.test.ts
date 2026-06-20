import { describe, expect, it } from 'vitest';
import {
  predictContinuousXY,
  trainContinuousXYModel,
  type ContinuousXYExample,
} from './continuous-xy-model.js';

describe('continuous XY model', () => {
  it('serializes numeric targets and predicts an interpolated coordinate', () => {
    const model = trainContinuousXYModel({
      examples: gridExamples(),
      roomWidthMeters: 4,
      roomHeightMeters: 4,
      featureVersion: 1,
    });
    expect(model.format).toBe('rfsense-continuous-xy-model/2');
    expect(model.examples[0]).toHaveProperty('xMeters');
    expect(model.examples[0]).not.toHaveProperty('label');

    const prediction = predictContinuousXY(model, {
      features: featuresFor(2, 2),
      receiverCount: 4,
      packetOverlap: 1,
    });
    expect(prediction.accepted).toBe(true);
    expect(prediction.xMeters).toBeGreaterThan(1.5);
    expect(prediction.xMeters).toBeLessThan(2.5);
    expect(prediction.yMeters).toBeGreaterThan(1.5);
    expect(prediction.yMeters).toBeLessThan(2.5);
    expect(prediction.xNormalized).toBeCloseTo((prediction.xMeters ?? 0) / 4, 6);
  });

  it('rejects empty room, missing receivers, low overlap, and OOD without origin coordinates', () => {
    const model = trainContinuousXYModel({
      examples: [...gridExamples(), emptyExample()],
      roomWidthMeters: 4,
      roomHeightMeters: 4,
      featureVersion: 1,
    });
    for (const input of [
      { features: featuresFor(2, 2), receiverCount: 2, packetOverlap: 1 },
      { features: featuresFor(2, 2), receiverCount: 4, packetOverlap: 0.5 },
      { features: featuresFor(10, 10), receiverCount: 4, packetOverlap: 1 },
      { features: emptyExample().features, receiverCount: 4, packetOverlap: 1, empty: true },
    ]) {
      const prediction = predictContinuousXY(model, input);
      expect(prediction.accepted).toBe(false);
      expect(prediction.xMeters).toBeNull();
      expect(prediction.yMeters).toBeNull();
      expect(prediction.xNormalized).toBeNull();
      expect(prediction.yNormalized).toBeNull();
      expect(prediction.reason).toBeTruthy();
    }
  });
});

function gridExamples(): ContinuousXYExample[] {
  const examples: ContinuousXYExample[] = [];
  for (const x of [1, 2, 3]) {
    for (const y of [1, 2, 3]) {
      examples.push(example(x, y, `grid-${x}-${y}`));
    }
  }
  return examples;
}

function example(xMeters: number, yMeters: number, recordingId: string): ContinuousXYExample {
  return {
    xMeters,
    yMeters,
    features: featuresFor(xMeters, yMeters),
    recordingId,
    subjectId: 'person-1',
    day: '2026-06-20',
    orientationDegrees: 0,
    movement: 'stationary',
    receiverCount: 4,
    packetOverlap: 1,
    empty: false,
  };
}

function emptyExample(): ContinuousXYExample {
  return {
    ...example(0, 0, 'empty-room'),
    features: Array(12).fill(-5) as number[],
    subjectId: 'empty-room',
    movement: 'empty',
    empty: true,
  };
}

function featuresFor(xMeters: number, yMeters: number): number[] {
  return [
    xMeters,
    yMeters,
    xMeters + yMeters,
    xMeters - yMeters,
    Math.hypot(xMeters, yMeters),
    xMeters * yMeters,
    xMeters ** 2,
    yMeters ** 2,
    4 - xMeters,
    4 - yMeters,
    1 / (0.1 + xMeters),
    1 / (0.1 + yMeters),
  ];
}
