import { describe, expect, it } from 'vitest';

import { ActivityClassifier } from './activity.js';
import { PortablePrototypeModel } from './model.js';

describe('aggregate activity classification', () => {
  it('stays in waiting state until two frames exist', () => {
    const classifier = new ActivityClassifier(undefined, 1);
    expect(classifier.evaluate([Float64Array.from([1, 1])]).state).toBe('waiting');
  });

  it('uses an explicit motion threshold without Python', () => {
    const classifier = new ActivityClassifier(undefined, 1);
    const result = classifier.evaluate([Float64Array.from([0, 0]), Float64Array.from([4, 4])]);
    expect(result.state).toBe('active');
    expect(result.confidence).toBe(1);
  });

  it('reports model activation as non-empty probability', () => {
    const model = new PortablePrototypeModel({
      format: 'rfsense-portable-model/1',
      target: 'label',
      window: 2,
      nFeatures: 8,
      classes: ['empty', 'occupied-moving', 'occupied-stationary'],
      featureMean: Array(8).fill(0),
      featureScale: Array(8).fill(1),
      prototypes: {
        empty: Array(8).fill(0),
        'occupied-moving': Array(8).fill(4),
        'occupied-stationary': Array(8).fill(5),
      },
      zones: {
        empty: { x: null, y: null },
        'occupied-moving': { x: null, y: null },
        'occupied-stationary': { x: null, y: null },
      },
      temperature: 100,
    });
    const result = new ActivityClassifier(model).evaluate([
      Float64Array.from([0, 0]),
      Float64Array.from([0, 0]),
    ]);

    expect(result.state).toBe('clear');
    expect(result.diagnostics.activationScore).toBeCloseTo(
      result.scores['occupied-moving']! + result.scores['occupied-stationary']!,
    );
  });
});
