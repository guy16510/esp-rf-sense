import { readFile } from 'node:fs/promises';

export type ReceiverSlot = 'A' | 'B' | 'C' | 'D';

export interface RoomPoint {
  x: number;
  y: number;
}

export interface RoomGeometry {
  format: 'rfsense-room-geometry/1';
  room: {
    name: string;
    widthMeters: number;
    heightMeters: number;
  };
  transmitter: RoomPoint & {
    name: string;
  };
  receivers: Array<
    RoomPoint & {
      slot: ReceiverSlot;
      deviceId: string;
      name?: string;
    }
  >;
  zones: Record<string, RoomPoint>;
}

const SLOTS: ReceiverSlot[] = ['A', 'B', 'C', 'D'];

export async function loadRoomGeometry(path: string): Promise<RoomGeometry> {
  return validateRoomGeometry(JSON.parse(await readFile(path, 'utf8')));
}

export function validateRoomGeometry(value: unknown): RoomGeometry {
  if (!isRecord(value) || value.format !== 'rfsense-room-geometry/1') {
    throw new Error('room geometry must use format rfsense-room-geometry/1');
  }
  if (!isRecord(value.room)) throw new Error('room geometry is missing room dimensions');
  const widthMeters = positive(value.room.widthMeters, 'room.widthMeters');
  const heightMeters = positive(value.room.heightMeters, 'room.heightMeters');
  const roomName = requiredString(value.room.name, 'room.name');

  if (!isRecord(value.transmitter)) throw new Error('room geometry is missing transmitter');
  const transmitter = {
    name: requiredString(value.transmitter.name, 'transmitter.name'),
    ...point(value.transmitter, widthMeters, heightMeters, 'transmitter'),
  };

  if (!Array.isArray(value.receivers)) throw new Error('room geometry receivers must be an array');
  const receivers = value.receivers.map((receiver, index) => {
    if (!isRecord(receiver)) throw new Error(`receivers[${index}] must be an object`);
    const slot = requiredString(receiver.slot, `receivers[${index}].slot`).toUpperCase();
    if (!SLOTS.includes(slot as ReceiverSlot)) {
      throw new Error(`receivers[${index}].slot must be A, B, C, or D`);
    }
    return {
      slot: slot as ReceiverSlot,
      deviceId: normalizeDeviceId(
        requiredString(receiver.deviceId, `receivers[${index}].deviceId`),
      ),
      ...(typeof receiver.name === 'string' && receiver.name.trim()
        ? { name: receiver.name.trim() }
        : {}),
      ...point(receiver, widthMeters, heightMeters, `receivers[${index}]`),
    };
  });
  if (receivers.length !== SLOTS.length) {
    throw new Error('room geometry must define exactly four receivers');
  }
  if (new Set(receivers.map((receiver) => receiver.slot)).size !== SLOTS.length) {
    throw new Error('room geometry must define each receiver slot A-D exactly once');
  }
  if (new Set(receivers.map((receiver) => receiver.deviceId)).size !== receivers.length) {
    throw new Error('room geometry receiver device IDs must be unique');
  }

  if (!isRecord(value.zones)) throw new Error('room geometry zones must be an object');
  const zones = Object.fromEntries(
    Object.entries(value.zones).map(([label, zone]) => {
      const cleanLabel = requiredString(label, 'zone label');
      if (!isRecord(zone)) throw new Error(`zone ${cleanLabel} must be an object`);
      return [cleanLabel, point(zone, widthMeters, heightMeters, `zones.${cleanLabel}`)];
    }),
  );
  if (Object.keys(zones).length < 2) {
    throw new Error('room geometry must define at least two labelled zones');
  }

  return {
    format: 'rfsense-room-geometry/1',
    room: { name: roomName, widthMeters, heightMeters },
    transmitter,
    receivers: receivers.sort((left, right) => left.slot.localeCompare(right.slot)),
    zones,
  };
}

export function normalizeRoomPoint(
  geometry: RoomGeometry,
  value: RoomPoint,
): { x: number; y: number } {
  return {
    x: value.x / geometry.room.widthMeters,
    y: value.y / geometry.room.heightMeters,
  };
}

function point(
  value: Record<string, unknown>,
  widthMeters: number,
  heightMeters: number,
  path: string,
): RoomPoint {
  const x = finite(value.x, `${path}.x`);
  const y = finite(value.y, `${path}.y`);
  if (x < 0 || x > widthMeters || y < 0 || y > heightMeters) {
    throw new Error(`${path} must be inside the configured room dimensions`);
  }
  return { x, y };
}

function normalizeDeviceId(value: string): string {
  const clean = value.toLowerCase().replace(/^0x/u, '').padStart(8, '0');
  if (!/^[0-9a-f]{8}$/u.test(clean)) throw new Error(`invalid receiver device ID: ${value}`);
  return clean;
}

function positive(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed <= 0) throw new Error(`${path} must be greater than zero`);
  return parsed;
}

function finite(value: unknown, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${path} must be a finite number`);
  return parsed;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
