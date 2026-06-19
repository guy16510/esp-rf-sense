#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import {
  argNumber,
  discoverReceivers,
  findMacLanIpv4,
  getJson,
  inventoryReceiver,
  normalizeBaseUrl,
  parseArgs,
  postJson,
} from './hardware-common.mjs';

const { values, lists } = parseArgs(process.argv.slice(2));
const explicitUrls = lists.get('device-url') ?? (values.has('device-url') ? [values.get('device-url')] : []);
const timeoutMs = argNumber(values, 'timeout', 10000);
const collectorPort = argNumber(values, 'collector-port', 5566);
const collectorHost = values.get('collector-host') ?? findMacLanIpv4().address;
const desired = { collectorHost, collectorPort, captureMode: 0, pingPps: 25 };

const devices =
  explicitUrls.length > 0
    ? explicitUrls.map((url) => ({ url: normalizeBaseUrl(url) }))
    : await discoverReceivers(timeoutMs);
if (devices.length < 4) throw new Error(`found ${devices.length} receiver(s); need four`);

const inventories = await Promise.all(devices.map((device) => inventoryReceiver(device.url)));
const unique = new Map(inventories.map((item) => [item.deviceId, item]));
if (unique.size < 4) throw new Error(`found ${unique.size} unique receiver(s); need four`);

const changed = [];
for (const item of unique.values()) {
  const patch = {};
  for (const [key, value] of Object.entries(desired)) {
    if (item.config[key] !== value) patch[key] = value;
  }
  if (Object.keys(patch).length === 0) continue;
  await postJson(item.url, '/api/v1/config', patch);
  changed.push(item);
}

for (const item of changed) await postJson(item.url, '/api/v1/reboot', {});

for (const item of changed) {
  const deadline = Date.now() + 45000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      await getJson(item.url, '/api/v1/health', 3000);
      healthy = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  if (!healthy) throw new Error(`${item.deviceId} did not return after reboot`);
}

const finalInventory = await Promise.all([...unique.values()].map((item) => inventoryReceiver(item.url)));
console.log(JSON.stringify({ collectorHost, collectorPort, changed: changed.map((item) => item.deviceId), receivers: finalInventory }, null, 2));
console.log(`slot arguments: ${finalInventory.map((item, index) => `--slot-${'abcd'[index]} ${item.deviceId}`).join(' ')}`);
