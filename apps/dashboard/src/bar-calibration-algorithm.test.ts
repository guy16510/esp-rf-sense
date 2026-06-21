import { describe, expect, it } from 'vitest';
import { captureQuality, recommendRecaptures, scorePlacement, secondPassGroup, transitionDecision } from './bar-calibration-algorithm.js';

describe('bar calibration algorithms', () => {
  it('recommends repeatedly confused zone pairs', () => {
    const result = recommendRecaptures([
      { actual: 'near-left', predicted: 'near-center', count: 4 },
      { actual: 'near-center', predicted: 'near-left', count: 3 },
      { actual: 'far-left', predicted: 'far-center', count: 1 },
    ]);
    expect(result.pairs).toEqual([{ left: 'near-center', right: 'near-left', count: 7 }]);
    expect(result.zones).toEqual(['near-center', 'near-left']);
  });

  it('stops clean diverse capture data early', () => {
    const decision = captureQuality({ elapsedSeconds: 10, frames: 240, receiverCount: 4, uniqueBuckets: 18, invalidFraction: 0.01 });
    expect(decision.stop).toBe(true);
  });

  it('blocks incomplete or correlated capture data', () => {
    const decision = captureQuality({ elapsedSeconds: 15, frames: 300, receiverCount: 3, uniqueBuckets: 4, invalidFraction: 0 });
    expect(decision.stop).toBe(false);
    expect(decision.reasons).toContain('all four receivers are required');
    expect(decision.reasons).toContain('signal diversity is too low');
  });

  it('scores spread geometry above clustered geometry', () => {
    const spread = scorePlacement([{ x: 0, y: 0, z: 1 }, { x: 6, y: 0, z: 2 }, { x: 0, y: 4, z: 1.5 }, { x: 6, y: 4, z: 2.2 }], 6, 4);
    const clustered = scorePlacement([{ x: 1, y: 1 }, { x: 1.2, y: 1 }, { x: 1.4, y: 1 }, { x: 1.6, y: 1 }], 6, 4);
    expect(spread.pass).toBe(true);
    expect(spread.score).toBeGreaterThan(clustered.score);
    expect(clustered.reasons).toContain('receiver geometry is too collinear');
  });

  it('rejects impossible fast jumps', () => {
    expect(transitionDecision('near-left', 'near-center', 200, 0.7).accepted).toBe(true);
    expect(transitionDecision('near-left', 'far-right', 200, 0.7)).toMatchObject({ accepted: false, zone: 'near-left' });
    expect(transitionDecision('near-left', 'far-right', 1500, 0.7).accepted).toBe(true);
  });

  it('creates second-pass group identifiers', () => {
    expect(secondPassGroup('quick-bar', 2, 'person-2', '2026-06-21')).toBe('quick-bar:pass-2:subject-person-2:day-2026-06-21');
  });
});
