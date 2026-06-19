#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  artifactPath,
  DEFAULT_DASHBOARD_URL,
  evaluatePlacement,
  loadRoomConfig,
  parseArgs,
  postJson,
  toDashboardRoomGeometry,
  validateRoomConfig,
  writeJson,
} from './hardware-common.mjs';

const { values } = parseArgs(process.argv.slice(2));
const dashboardUrl = values.get('dashboard-url') ?? DEFAULT_DASHBOARD_URL;
const roomPath = values.get('room-config') ?? 'config/hardware-room.json';
const recordingsDir = values.get('recordings-dir') ?? 'recordings/hardware-xy';
const modelPath = values.get('model-path') ?? 'models/hardware-position.json';
const outPath = values.get('out') ?? artifactPath('position-validation.json');
const room = validateRoomConfig(await loadRoomConfig(roomPath));
const placement = evaluatePlacement(room);
if (!placement.pass) throw new Error(placement.message);

const response = await postJson(dashboardUrl, '/api/model/train', {
  path: modelPath,
  target: 'position',
  minRecordingsPerClass: Number(values.get('min-recordings-per-class') ?? 2),
  roomGeometry: toDashboardRoomGeometry(room),
  window: Number(values.get('window') ?? 64),
  step: Number(values.get('step') ?? 32),
});
const model = JSON.parse(await readFile(modelPath, 'utf8'));
const recordingCounts = await recordingCountsByClass(recordingsDir);
const leaveOneRecording = model.validation?.metrics?.find((metric) => metric.protocol === 'leave-one-recording-out');
const report = {
  generatedAt: new Date().toISOString(),
  resultType: 'calibrated coarse zone with mapped coordinates',
  continuousXY: false,
  continuousXYStatement: 'This output is calibrated-zone coordinates, not arbitrary continuous XY.',
  modelStatus: response,
  classes: model.classes,
  recordingCountByClass: recordingCounts,
  exactZoneAccuracy: leaveOneRecording?.accuracy ?? null,
  acceptedCoverage: null,
  emptyRoomFalseAcceptanceRate: null,
  confusionMatrix: null,
  confidenceDistribution: null,
  receiverAgreementDistribution: null,
  rejectedSampleCount: null,
  testRecordingIds: null,
  validation: model.validation ?? null,
  placement,
};
await writeJson(outPath, report);
console.log(JSON.stringify(report, null, 2));

async function recordingCountsByClass(directory) {
  const result = {};
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (!meta.complete) continue;
    const label = /empty|clear/iu.test(meta.label) ? 'empty' : meta.position?.label ?? meta.subject?.position?.label ?? meta.label;
    result[label] = (result[label] ?? 0) + 1;
  }
  return result;
}
