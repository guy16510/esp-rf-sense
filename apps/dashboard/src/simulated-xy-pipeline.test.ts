import { describe, expect, it } from 'vitest';
import { buildSyntheticDataset, predictXY, simulateFourReceiverExample, trainXYModel, validateSyntheticXY } from './simulated-xy-pipeline.js';

describe('four receiver XY localization', () => {
  it('passes synthetic promotion gates after training', () => {
    const dataset = buildSyntheticDataset();
    expect(dataset.length).toBeGreaterThan(500);
    expect(dataset.every((example) => example.features.length === 26)).toBe(true);
    const model = trainXYModel(dataset);
    const report = validateSyntheticXY(model);
    expect(report.medianErrorMeters).toBeLessThanOrEqual(0.75);
    expect(report.p90ErrorMeters).toBeLessThanOrEqual(1.5);
    expect(report.falseAcceptedEmptyRate).toBeLessThanOrEqual(0.05);
    expect(report.oodRejectionRate).toBeGreaterThanOrEqual(0.9);
    expect(report.threeReceiverAcceptedRate).toBeGreaterThanOrEqual(0.95);
    expect(report.acceptedCoverage).toBeGreaterThanOrEqual(0.8);
    expect(report.passed).toBe(true);
  });

  it('predicts an unseen continuous coordinate with uncertainty', () => {
    const model = trainXYModel(buildSyntheticDataset());
    const sample = simulateFourReceiverExample({ xMeters: 2.15, yMeters: 1.35 }, 99123, {
      recordingId: 'live-unseen-coordinate', subjectId: 'person-live', day: '2026-06-26',
      orientationDegrees: 135, receiverCount: 4, packetOverlap: 0.95,
    });
    const prediction = predictXY(model, sample);
    expect(prediction.accepted).toBe(true);
    expect(prediction.rejectionReason).toBeNull();
    expect(prediction.uncertaintyMeters).toBeLessThanOrEqual(0.75);
    expect(Math.hypot(prediction.xMeters - 2.15, prediction.yMeters - 1.35)).toBeLessThanOrEqual(0.75);
  });

  it('rejects empty, out of distribution, and low receiver windows', () => {
    const model = trainXYModel(buildSyntheticDataset());
    const empty = simulateFourReceiverExample({ xMeters: 2, yMeters: 2 }, 120001, { empty: true });
    const outside = simulateFourReceiverExample({ xMeters: 9, yMeters: 9 }, 120002);
    const lowReceiver = simulateFourReceiverExample({ xMeters: 2, yMeters: 2 }, 120003, { receiverCount: 2 });
    expect(predictXY(model, empty)).toMatchObject({ accepted: false, rejectionReason: 'empty-room' });
    expect(predictXY(model, outside)).toMatchObject({ accepted: false, rejectionReason: 'outside-calibrated-area' });
    expect(predictXY(model, lowReceiver)).toMatchObject({ accepted: false, rejectionReason: 'insufficient-receivers' });
  });
});
