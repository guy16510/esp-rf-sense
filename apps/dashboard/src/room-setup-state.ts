import type { RoomGeometry } from './room-geometry.js';

export interface RoomSetupZone {
  id: string;
  label: string;
  x: number;
  y: number;
  captures: {
    stationary: number;
    moving: number;
  };
}

export interface RoomSetupState {
  roomName: string;
  widthFeet: number;
  lengthFeet: number;
  subjectId: string;
  emptyRecordings: number;
  zones: RoomSetupZone[];
  validation: Record<string, boolean>;
  modelLoaded: boolean;
}

export interface ReceiverIdentity {
  deviceId: string;
}

export interface RoomSetupGate {
  completed: number;
  maxUnlocked: number;
  trainingReady: boolean;
  blocker: string;
}

export function createDefaultRoomSetup(): RoomSetupState {
  return {
    roomName: 'Tap room',
    widthFeet: 6,
    lengthFeet: 5,
    subjectId: 'person-1',
    emptyRecordings: 0,
    zones: [
      zone('door', 0.5, 0.12),
      zone('left', 0.2, 0.5),
      zone('center', 0.5, 0.5),
      zone('right', 0.8, 0.5),
    ],
    validation: {},
    modelLoaded: false,
  };
}

export function deriveRoomSetupGate(
  state: RoomSetupState,
  receiversReady: boolean,
): RoomSetupGate {
  const roomReady = roomDefinitionValid(state);
  const receiverGate = roomReady && receiversReady;
  const emptyReady = receiverGate && state.emptyRecordings >= 2;
  const capturesReady = emptyReady && zonesComplete(state);
  const modelReady = capturesReady && state.modelLoaded;
  const flags = [roomReady, receiverGate, emptyReady, capturesReady, modelReady];
  let maxUnlocked = 0;
  for (let index = 0; index < flags.length - 1; index++) {
    if (!flags[index]) break;
    maxUnlocked = index + 1;
  }
  const blocker = !roomReady
    ? 'Enter a room name, dimensions, and person ID.'
    : !receiverGate
      ? 'All four receivers must be healthy before capture.'
      : !emptyReady
        ? 'Collect 2 empty-room recordings.'
        : !capturesReady
          ? 'Record one stationary session for every zone.'
          : !modelReady
            ? 'Train and load the position model.'
            : 'Room setup is complete.';
  return {
    completed: flags.filter(Boolean).length,
    maxUnlocked,
    trainingReady: capturesReady,
    blocker,
  };
}

export function buildRoomSetupGeometry(
  state: RoomSetupState,
  receivers: readonly ReceiverIdentity[],
): RoomGeometry {
  if (!roomDefinitionValid(state)) throw new Error('room setup is incomplete');
  if (receivers.length !== 4) throw new Error('exactly four receivers are required');
  const widthMeters = feetToMeters(state.widthFeet);
  const heightMeters = feetToMeters(state.lengthFeet);
  const points = [
    { slot: 'A' as const, x: 0, y: 0 },
    { slot: 'B' as const, x: widthMeters, y: 0 },
    { slot: 'C' as const, x: 0, y: heightMeters },
    { slot: 'D' as const, x: widthMeters, y: heightMeters },
  ];
  return {
    format: 'rfsense-room-geometry/1',
    room: {
      name: state.roomName.trim(),
      widthMeters,
      heightMeters,
    },
    transmitter: {
      name: 'room-router',
      x: widthMeters / 2,
      y: 0,
    },
    receivers: points.map((point, index) => ({
      ...point,
      deviceId: normalizeDeviceId(receivers[index]?.deviceId ?? ''),
      name: `Receiver ${point.slot}`,
    })),
    zones: Object.fromEntries(
      state.zones.map((item) => [
        item.label,
        { x: item.x * widthMeters, y: item.y * heightMeters },
      ]),
    ),
  };
}

export function roomDefinitionValid(state: RoomSetupState): boolean {
  return Boolean(
    state.roomName.trim() &&
      state.subjectId.trim() &&
      Number.isFinite(state.widthFeet) &&
      state.widthFeet > 0 &&
      Number.isFinite(state.lengthFeet) &&
      state.lengthFeet > 0 &&
      state.zones.length >= 2 &&
      state.zones.every(
        (item) =>
          item.label.trim() &&
          Number.isFinite(item.x) &&
          item.x >= 0 &&
          item.x <= 1 &&
          Number.isFinite(item.y) &&
          item.y >= 0 &&
          item.y <= 1,
      ) &&
      new Set(state.zones.map((item) => item.label.trim())).size === state.zones.length,
  );
}

export function zonesComplete(state: RoomSetupState): boolean {
  return (
    state.zones.length >= 2 &&
    state.zones.every((item) => item.captures.stationary >= 1)
  );
}

export function validationsComplete(state: RoomSetupState): boolean {
  return state.zones.length >= 2 && state.zones.every((item) => state.validation[item.id] === true);
}

function feetToMeters(value: number): number {
  return Number((value * 0.3048).toFixed(4));
}

function zone(label: string, x: number, y: number): RoomSetupZone {
  return {
    id: label,
    label,
    x,
    y,
    captures: { stationary: 0, moving: 0 },
  };
}

function normalizeDeviceId(value: string): string {
  const clean = value.toLowerCase().replace(/^0x/u, '').padStart(8, '0');
  if (!/^[0-9a-f]{8}$/u.test(clean)) throw new Error(`invalid receiver device ID: ${value}`);
  return clean;
}
