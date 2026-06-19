#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_DASHBOARD_URL,
  encodedRecordingLabel,
  ensureFourReady,
  evaluatePlacement,
  loadRoomConfig,
  normalizeCalibrationPoint,
  parseArgs,
  postJson,
  validateRoomConfig,
} from './hardware-common.mjs';

const { values } = parseArgs(process.argv.slice(2));
const dashboardUrl = values.get('dashboard-url') ?? DEFAULT_DASHBOARD_URL;
const roomPath = values.get('room-config') ?? 'config/hardware-room.json';
const subjectId = values.get('subject-id') ?? 'hardware-smoke-subject';
const day = values.get('day') ?? new Date().toISOString().slice(0, 10);
const targetSeconds = Number(values.get('seconds') ?? 75);
const targetFrames = Number(values.get('frames') ?? 2000);
const repeats = Number(values.get('repeats') ?? 2);
const room = validateRoomConfig(await loadRoomConfig(roomPath));
const placement = evaluatePlacement(room);
if (!placement.pass) throw new Error(placement.message);

const rl = createInterface({ input, output });
const recordings = [];
try {
  await ensureFourReady(dashboardUrl);
  await postJson(dashboardUrl, '/api/baseline/reset', {});
  console.log('Baseline reset. Keep the room empty until prompted.');

  const classes = [{ label: 'empty', empty: true }, ...room.calibrationPoints.map((point) => ({ ...point, empty: false }))];
  for (const item of classes) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const movement = item.empty ? 'empty' : repeat % 2 === 0 ? 'slow-moving' : 'stationary';
      const point = item.empty ? null : normalizeCalibrationPoint(room, item);
      console.log(`\nNext recording: ${item.label} repeat ${repeat}/${repeats} (${movement})`);
      if (point) console.log(`meters=(${point.xMeters}, ${point.yMeters}) normalized=(${point.normalizedX.toFixed(3)}, ${point.normalizedY.toFixed(3)})`);
      await rl.question('Confirm position and press Enter to record.');
      await ensureFourReady(dashboardUrl);
      const metadata = {
        label: item.empty ? 'empty' : `occupied-${item.label}`,
        target: 'position',
        subjectId: item.empty ? 'empty-room' : subjectId,
        day,
        movement,
        position: item.empty ? { label: 'empty', x: null, y: null } : { label: item.label, x: point.normalizedX, y: point.normalizedY },
      };
      const started = await postJson(dashboardUrl, '/api/recording/start', {
        label: encodedRecordingLabel(metadata),
        targetSeconds,
        targetFrames,
      });
      console.log(`recording ${started.name}`);
      let status = started;
      while (status.active) {
        await delay(1000);
        status = await (await fetch(new URL('/api/recording', dashboardUrl))).json();
        process.stdout.write(`\r${status.elapsedSeconds}s ${status.frames}/${targetFrames} frames`);
      }
      process.stdout.write('\n');
      if (status.frames < targetFrames) throw new Error(`${status.name} ended with only ${status.frames} frames`);
      recordings.push(status);
    }
  }
  console.log(JSON.stringify({ recordings }, null, 2));
} finally {
  rl.close();
}
