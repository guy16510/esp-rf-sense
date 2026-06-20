import { describe, expect, it } from 'vitest';

import {
  buildRoomSetupGeometry,
  createDefaultRoomSetup,
  deriveRoomSetupGate,
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

  it('requires independent empty and stationary captures before training', () => {
    const state = createDefaultRoomSetup();
    state.emptyRecordings = 2;
    expect(deriveRoomSetupGate(state, true).maxUnlocked).toBe(3);
    expect(zonesComplete(state)).toBe(false);

    for (const zone of state.zones) {
      zone.captures.stationary = 1;
    }
    expect(zonesComplete(state)).toBe(true);
    expect(deriveRoomSetupGate(state, true)).toMatchObject({
      maxUnlocked: 4,
      trainingReady: true,
      blocker: 'Train and load the position model.',
    });
  });

  it('marks onboarding complete once the position model is loaded', () => {
    const state = createDefaultRoomSetup();
    state.emptyRecordings = 2;
    state.modelLoaded = true;
    for (const zone of state.zones) {
      zone.captures.stationary = 1;
    }
    expect(deriveRoomSetupGate(state, true)).toMatchObject({
      completed: 5,
      blocker: 'Room setup is complete.',
    });
  });

  it('converts normalized zones into validated room geometry for training', () => {
    const state = createDefaultRoomSetup();
    const geometry = buildRoomSetupGeometry(state, receivers);

    expect(geometry.room).toEqual({ name: 'Tap room', widthMeters: 1.8288, heightMeters: 1.524 });
    expect(geometry.receivers.map((receiver) => receiver.slot)).toEqual(['A', 'B', 'C', 'D']);
    expect(geometry.receivers.map((receiver) => receiver.deviceId)).toEqual([
      '00000001',
      '00000002',
      '00000003',
      '00000004',
    ]);
    expect(geometry.zones.center).toEqual({ x: 0.9144, y: 0.762 });
    expect(geometry.transmitter).toEqual({ name: 'room-router', x: 0.9144, y: 0 });
  });

  it('uses updated room dimensions when building geometry for retraining', () => {
    const state = createDefaultRoomSetup();
    state.roomName = 'Changed room';
    state.widthFeet = 8;
    state.lengthFeet = 4;

    const geometry = buildRoomSetupGeometry(state, receivers);

    expect(geometry.room).toEqual({
      name: 'Changed room',
      widthMeters: 2.4384,
      heightMeters: 1.2192,
    });
    expect(geometry.receivers).toMatchObject([
      { slot: 'A', x: 0, y: 0 },
      { slot: 'B', x: 2.4384, y: 0 },
      { slot: 'C', x: 0, y: 1.2192 },
      { slot: 'D', x: 2.4384, y: 1.2192 },
    ]);
    expect(geometry.zones.center).toEqual({ x: 1.2192, y: 0.6096 });
    expect(geometry.zones.door).toEqual({ x: 1.2192, y: 0.146304 });
    expect(geometry.transmitter).toEqual({ name: 'room-router', x: 1.2192, y: 0 });
  });

  it('converts equal square-room dimensions from feet and inches', () => {
    const state = createDefaultRoomSetup();
    state.widthFeet = 20 + 7 / 12;
    state.lengthFeet = 20 + 7 / 12;

    const geometry = buildRoomSetupGeometry(state, receivers);

    expect(geometry.room).toEqual({
      name: 'Tap room',
      widthMeters: 6.2738,
      heightMeters: 6.2738,
    });
    expect(geometry.receivers).toMatchObject([
      { slot: 'A', x: 0, y: 0 },
      { slot: 'B', x: 6.2738, y: 0 },
      { slot: 'C', x: 0, y: 6.2738 },
      { slot: 'D', x: 6.2738, y: 6.2738 },
    ]);
  });
});
