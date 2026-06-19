import { describe, expect, it } from 'vitest';

import {
  buildRoomSetupGeometry,
  createDefaultRoomSetup,
  deriveRoomSetupGate,
  validationsComplete,
  zonesComplete,
} from './room-setup-state.js';

const receivers = [
  { deviceId: '1' },
  { deviceId: '2' },
  { deviceId: '3' },
  { deviceId: '4' },
];

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
    const geometry = buildRoomSetupGeometry(state, receivers);

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

  it('uses updated room dimensions when building geometry for retraining', () => {
    const state = createDefaultRoomSetup();
    state.roomName = 'Changed room';
    state.widthMeters = 8;
    state.heightMeters = 4;

    const geometry = buildRoomSetupGeometry(state, receivers);

    expect(geometry.room).toEqual({
      name: 'Changed room',
      widthMeters: 8,
      heightMeters: 4,
    });
    expect(geometry.receivers).toMatchObject([
      { slot: 'A', x: 0, y: 0 },
      { slot: 'B', x: 8, y: 0 },
      { slot: 'C', x: 0, y: 4 },
      { slot: 'D', x: 8, y: 4 },
    ]);
    expect(geometry.zones.center).toEqual({ x: 4, y: 2 });
    expect(geometry.zones.door).toEqual({ x: 4, y: 0.48 });
    expect(geometry.transmitter).toEqual({ name: 'room-router', x: 4, y: 0 });
  });
});
