import { describe, expect, it } from 'vitest';

import {
  buildRoomSetupGeometry,
  createDefaultRoomSetup,
  deriveRoomSetupGate,
  validationsComplete,
  zonesComplete,
} from './room-setup-state.js';

describe('guided room setup state', () => {
  it('gates capture until the room definition and four receivers are ready', () => {
    const state = createDefaultRoomSetup();
    expect(deriveRoomSetupGate(state, false)).toMatchObject({
      maxUnlocked: 1,
      trainingReady: false,
      blocker: 'All four receivers must be healthy before capture.',
    });

    expect(deriveRoomSetupGate(state, true)).toMatchObject({
      maxUnlocked: 2,
      blocker: 'Collect 2 empty-room recordings.',
    });
  });

  it('requires independent empty, stationary, and moving captures before training', () => {
    const state = createDefaultRoomSetup();
    state.emptyRecordings = 2;
    expect(deriveRoomSetupGate(state, true).maxUnlocked).toBe(3);
    expect(zonesComplete(state)).toBe(false);

    for (const zone of state.zones) {
      zone.captures.stationary = 1;
      zone.captures.moving = 1;
    }
    expect(zonesComplete(state)).toBe(true);
    expect(deriveRoomSetupGate(state, true)).toMatchObject({
      maxUnlocked: 4,
      trainingReady: true,
      blocker: 'Train and load the position model.',
    });
  });

  it('does not mark onboarding complete until every trained zone passes live validation', () => {
    const state = createDefaultRoomSetup();
    state.emptyRecordings = 2;
    state.modelLoaded = true;
    for (const zone of state.zones) {
      zone.captures.stationary = 1;
      zone.captures.moving = 1;
    }
    expect(deriveRoomSetupGate(state, true).maxUnlocked).toBe(5);
    expect(validationsComplete(state)).toBe(false);

    for (const zone of state.zones) state.validation[zone.id] = true;
    expect(validationsComplete(state)).toBe(true);
    expect(deriveRoomSetupGate(state, true)).toMatchObject({
      completed: 6,
      blocker: 'Room setup is complete.',
    });
  });

  it('converts normalized zones into validated room geometry for training', () => {
    const state = createDefaultRoomSetup();
    const geometry = buildRoomSetupGeometry(state, [
      { deviceId: '1' },
      { deviceId: '2' },
      { deviceId: '3' },
      { deviceId: '4' },
    ]);

    expect(geometry.room).toEqual({ name: 'Tap room', widthMeters: 6, heightMeters: 5 });
    expect(geometry.receivers.map((receiver) => receiver.slot)).toEqual(['A', 'B', 'C', 'D']);
    expect(geometry.receivers.map((receiver) => receiver.deviceId)).toEqual([
      '00000001',
      '00000002',
      '00000003',
      '00000004',
    ]);
    expect(geometry.zones.center).toEqual({ x: 3, y: 2.5 });
    expect(geometry.transmitter).toEqual({ name: 'room-router', x: 3, y: 0 });
  });
});
