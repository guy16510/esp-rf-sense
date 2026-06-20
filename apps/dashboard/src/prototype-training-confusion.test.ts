import { describe, expect, it } from 'vitest';
import { validateExamples } from './prototype-training.js';

describe('validation confusion', () => {
  it('reports grouped actual and predicted counts', () => {
    const make = (label, recordingId, feature) => ({
      features: [feature, feature * 0.5],
      label,
      recordingId,
      subjectId: recordingId,
      day: recordingId,
      position: label,
    });
    const report = validateExamples([
      make('left', 'r1', 0), make('left', 'r1', 0.1),
      make('right', 'r1', 10), make('right', 'r1', 10.1),
      make('left', 'r2', 9.8), make('left', 'r2', 9.9),
      make('right', 'r2', 0.2), make('right', 'r2', 0.3),
    ]);
    const metric = report.metrics.find((item) => item.protocol === 'leave-one-recording-out');
    expect(metric.folds).toBe(2);
    expect(metric.samples).toBe(8);
    expect(metric.confusion).toEqual(expect.arrayContaining([
      expect.objectContaining({ actual: 'left', predicted: 'right' }),
      expect.objectContaining({ actual: 'right', predicted: 'left' }),
    ]));
  });
});
