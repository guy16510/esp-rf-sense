import { describe, expect, it } from 'vitest';

import { ActivityClassifier } from './activity.js';

describe('aggregate activity classification', () => {
  it('stays in waiting state until two frames exist', () => {
    const classifier = new ActivityClassifier(undefined, 1);
    expect(classifier.evaluate([Float64Array.from([1, 1])]).state).toBe('waiting');
  });

  it('uses an explicit motion threshold without Python', () => {
    const classifier = new ActivityClassifier(undefined, 1);
    const result = classifier.evaluate([
      Float64Array.from([0, 0]),
      Float64Array.from([4, 4]),
    ]);
    expect(result.state).toBe('active');
    expect(result.confidence).toBe(1);
  });
});
