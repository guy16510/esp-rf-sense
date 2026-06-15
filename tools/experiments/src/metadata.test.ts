import { describe, expect, it } from 'vitest';

import { validateMetadata, type ExperimentMetadata } from './metadata.js';
import { TEMPLATES } from './templates.js';

function base(): ExperimentMetadata {
  return {
    schemaVersion: 1,
    experimentId: 'occupancy-room-A',
    sessionId: 'stationary-2026-01-01',
    group: 'stationary',
    label: 'occupied-stationary',
    room: 'Room A',
    day: '2026-01-01',
    captureMode: 'controlled',
    link: { txDescription: 'Asus RT-AX55', channel: 6, pingPps: 25 },
    subject: { count: 1, subjectIds: ['p01'], movement: 'stationary' },
    recordingName: 'stationary-2026-01-01',
    startedAt: '2026-01-01T10:00:00Z',
    complete: false,
    notes: '',
  };
}

describe('validateMetadata', () => {
  it('accepts a fully specified session', () => {
    expect(validateMetadata(base()).ok).toBe(true);
  });

  it('requires a YYYY-MM-DD day for leave-one-day-out CV', () => {
    const m = { ...base(), day: 'Jan 1' };
    const r = validateMetadata(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('day'))).toBe(true);
  });

  it('requires subjectIds to match a non-empty count', () => {
    const m = { ...base(), subject: { count: 2, subjectIds: ['p01'], movement: 'mixed' as const } };
    const r = validateMetadata(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('subjectIds'))).toBe(true);
  });

  it('allows an empty-baseline session with zero subjects', () => {
    const m: ExperimentMetadata = {
      ...base(),
      group: 'empty-baseline',
      label: 'empty',
      subject: { count: 0, subjectIds: [], movement: 'none' },
    };
    expect(validateMetadata(m).ok).toBe(true);
  });

  it('rejects an unknown capture mode', () => {
    const m = { ...base(), captureMode: 'bogus' as unknown as ExperimentMetadata['captureMode'] };
    expect(validateMetadata(m).ok).toBe(false);
  });

  it('flags missing required fields', () => {
    const r = validateMetadata({ schemaVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(3);
  });

  it('requires an end time once a session is complete', () => {
    const r = validateMetadata({ ...base(), complete: true });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('endedAt'))).toBe(true);
  });
});

describe('TEMPLATES', () => {
  it('defines the five initial experiment groups', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['empty-baseline', 'moving', 'multi-person', 'position-grid', 'stationary'].sort(),
    );
  });

  it('empty-baseline expects zero subjects, multi-person expects 2+', () => {
    expect(TEMPLATES['empty-baseline']!.defaults.subjectCount).toBe(0);
    expect(TEMPLATES['multi-person']!.defaults.subjectCount).toBeGreaterThanOrEqual(2);
  });
});
