import { describe, expect, it } from 'vitest';

import { FLAG_MAINTENANCE } from './protocol.js';
import { StreamTracker } from './stats.js';

describe('StreamTracker', () => {
  it('counts datagrams and frames per stream', () => {
    const t = new StreamTracker();
    t.record({ deviceId: 1, bootId: 1 }, 0, 5, 0, 1000);
    t.record({ deviceId: 1, bootId: 1 }, 1, 4, 0, 1001);
    const s = t.snapshot();
    expect(s.validDatagrams).toBe(2);
    expect(s.streams[0]!.framesReceived).toBe(9);
    expect(s.streams[0]!.lostEstimate).toBe(0);
  });

  it('estimates loss from a packetSeq gap', () => {
    const t = new StreamTracker();
    t.record({ deviceId: 1, bootId: 1 }, 10, 1, 0, 0);
    const r = t.record({ deviceId: 1, bootId: 1 }, 14, 1, 0, 0); // skipped 11,12,13
    expect(r.gap).toBe(3);
    expect(t.snapshot().streams[0]!.lostEstimate).toBe(3);
  });

  it('treats a new bootId as a reboot, not loss', () => {
    const t = new StreamTracker();
    t.record({ deviceId: 1, bootId: 1 }, 500, 1, 0, 0);
    const r = t.record({ deviceId: 1, bootId: 2 }, 0, 1, 0, 0);
    expect(r.rebooted).toBe(true);
    expect(r.gap).toBe(0);
    expect(t.snapshot().reboots).toBe(1);
    // The first boot's stream is independent from the second's.
    expect(t.snapshot().streams).toHaveLength(2);
  });

  it('flags duplicates and reordering without counting them as loss', () => {
    const t = new StreamTracker();
    t.record({ deviceId: 1, bootId: 1 }, 5, 1, 0, 0);
    t.record({ deviceId: 1, bootId: 1 }, 5, 1, 0, 0); // duplicate
    t.record({ deviceId: 1, bootId: 1 }, 3, 1, 0, 0); // reordered (older)
    const s = t.snapshot().streams[0]!;
    expect(s.duplicates).toBe(1);
    expect(s.outOfOrder).toBe(1);
    expect(s.lostEstimate).toBe(0);
  });

  it('tallies maintenance datagrams', () => {
    const t = new StreamTracker();
    t.record({ deviceId: 1, bootId: 1 }, 0, 0, FLAG_MAINTENANCE, 0);
    expect(t.snapshot().streams[0]!.maintenanceDatagrams).toBe(1);
  });

  it('records invalid datagrams with reasons', () => {
    const t = new StreamTracker();
    t.recordInvalid('bad magic');
    t.recordInvalid('bad magic');
    t.recordInvalid('crc mismatch');
    const s = t.snapshot();
    expect(s.invalidDatagrams).toBe(3);
    expect(s.invalidReasons['bad magic']).toBe(2);
  });
});
