#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  argNumber,
  createRoomConfig,
  discoverReceivers,
  inventoryReceiver,
  loadRoomConfig,
  normalizeBaseUrl,
  parseArgs,
  postJson,
  REQUIRED_SLOTS,
  saveRoomConfig,
} from './hardware-common.mjs';

const { values, lists } = parseArgs(process.argv.slice(2));
const explicitUrls = lists.get('device-url') ?? (values.has('device-url') ? [values.get('device-url')] : []);
const timeoutMs = argNumber(values, 'timeout', 10000);
const roomPath = values.get('room-config') ?? 'config/hardware-room.json';
const durationMs = argNumber(values, 'duration-ms', 10000);
const forceReposition = values.has('reposition');
const devices =
  explicitUrls.length > 0
    ? explicitUrls.map((url) => ({ url: normalizeBaseUrl(url) }))
    : await discoverReceivers(timeoutMs);
if (devices.length < 4) throw new Error(`found ${devices.length} receiver(s); need four`);

const receivers = await Promise.all(devices.map((device) => inventoryReceiver(device.url)));
const unique = [...new Map(receivers.map((item) => [item.deviceId, item])).values()];
if (unique.length < 4) throw new Error(`found ${unique.length} unique receiver(s); need four`);

const rl = createInterface({ input, output });
const assignments = new Map();
const invisible = [];
try {
  for (const receiver of unique) {
    console.log(`\nIdentifying ${receiver.deviceId} (${receiver.deviceName ?? receiver.url}) at ${receiver.url}`);
    let response;
    try {
      response = await postJson(receiver.url, '/api/v1/identify', { durationMs });
    } catch (error) {
      throw new Error(`${receiver.deviceId} does not support /api/v1/identify yet: ${error.message}`);
    }
    console.log(JSON.stringify(response));
    const answer = (await rl.question('Observed slot [A/B/C/D/not visible]: ')).trim().toUpperCase();
    if (answer === 'NOT VISIBLE' || answer === 'NONE' || answer === 'N') {
      invisible.push(receiver);
      continue;
    }
    if (!REQUIRED_SLOTS.includes(answer)) throw new Error(`invalid slot: ${answer}`);
    if (assignments.has(answer)) throw new Error(`slot ${answer} was already assigned`);
    assignments.set(answer, receiver);
  }

  const remainingSlots = REQUIRED_SLOTS.filter((slot) => !assignments.has(slot));
  if (invisible.length > 0) {
    if (invisible.length !== 1 || remainingSlots.length !== 1) {
      throw new Error('non-visible receivers can be assigned by elimination only when exactly one receiver and one slot remain');
    }
    assignments.set(remainingSlots[0], invisible[0]);
  }

  if (assignments.size !== 4) throw new Error('slot mapping is incomplete');

  let room;
  try {
    room = await loadRoomConfig(roomPath);
  } catch {
    const widthMeters = Number(await rl.question('Room width in meters (approximate): '));
    const heightMeters = Number(await rl.question('Room height in meters (approximate): '));
    room = createRoomConfig({ widthMeters, heightMeters });
  }
  room.receivers = room.receivers ?? {};
  for (const slot of REQUIRED_SLOTS) {
    const current = room.receivers[slot] ?? {};
    const hasCoordinates =
      !forceReposition &&
      Number.isFinite(Number(current.xMeters)) &&
      Number.isFinite(Number(current.yMeters));
    const point = hasCoordinates
      ? { xMeters: Number(current.xMeters), yMeters: Number(current.yMeters) }
      : await promptReceiverPoint(rl, slot, room.widthMeters, room.heightMeters);
    room.receivers[slot] = {
      deviceId: assignments.get(slot).deviceId,
      xMeters: point.xMeters,
      yMeters: point.yMeters,
    };
  }
  await saveRoomConfig(room, roomPath);
  console.log(`\nwrote ${roomPath}`);
  console.log(JSON.stringify(room.receivers, null, 2));
} finally {
  rl.close();
}

async function promptReceiverPoint(rl, slot, widthMeters, heightMeters) {
  const xMeters = Number(await rl.question(`Receiver ${slot} xMeters from left edge (0-${widthMeters}): `));
  const yMeters = Number(await rl.question(`Receiver ${slot} yMeters from top edge (0-${heightMeters}): `));
  if (
    !Number.isFinite(xMeters) ||
    !Number.isFinite(yMeters) ||
    xMeters < 0 ||
    xMeters > widthMeters ||
    yMeters < 0 ||
    yMeters > heightMeters
  ) {
    throw new Error(`receiver ${slot} coordinates must be inside the room`);
  }
  return { xMeters, yMeters };
}
