#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import {
  argNumber,
  artifactPath,
  DEFAULT_DASHBOARD_URL,
  fetchDashboardNodes,
  parseArgs,
  writeJson,
} from './hardware-common.mjs';

const { values } = parseArgs(process.argv.slice(2));
const dashboardUrl = values.get('dashboard-url') ?? DEFAULT_DASHBOARD_URL;
const expected = values.get('expected') ?? 'center';
const xMeters = Number(values.get('x-meters') ?? NaN);
const yMeters = Number(values.get('y-meters') ?? NaN);
const roomWidth = Number(values.get('room-width') ?? 4);
const roomHeight = Number(values.get('room-height') ?? 4);
const durationSeconds = argNumber(values, 'duration', 30);
const outPath = values.get('out') ?? artifactPath(`live-position-${expected}.json`);
const samples = [];
const started = Date.now();

while (Date.now() - started < durationSeconds * 1000) {
  const snapshot = await fetchDashboardNodes(dashboardUrl);
  samples.push({
    timestamp: snapshot.timestamp,
    accepted: Boolean(snapshot.fused?.position?.accepted),
    zone: snapshot.fused?.position?.zone ?? null,
    x: snapshot.fused?.position?.x ?? null,
    y: snapshot.fused?.position?.y ?? null,
    contributors: snapshot.fused?.position?.contributors ?? 0,
    agreement: snapshot.fused?.position?.agreement ?? 0,
    confidence: snapshot.fused?.position?.confidence ?? 0,
    reason: snapshot.fused?.position?.reason ?? null,
  });
  await delay(500);
}

const accepted = samples.filter((sample) => sample.accepted);
const matches =
  expected === 'empty'
    ? samples.filter((sample) => !sample.accepted)
    : accepted.filter((sample) => sample.zone === expected);
const coordinateErrors = accepted
  .filter((sample) => Number.isFinite(xMeters) && Number.isFinite(yMeters) && sample.x !== null && sample.y !== null)
  .map((sample) => Math.hypot(sample.x * roomWidth - xMeters, sample.y * roomHeight - yMeters));
const summary = {
  generatedAt: new Date().toISOString(),
  expected,
  durationSeconds,
  sampleCount: samples.length,
  acceptedCount: accepted.length,
  exactZoneSuccessRate: samples.length > 0 ? matches.length / samples.length : 0,
  coordinateErrorMeters: stats(coordinateErrors),
  minContributors: accepted.length ? Math.min(...accepted.map((sample) => sample.contributors)) : null,
  medianAgreement: median(accepted.map((sample) => sample.agreement)),
  medianConfidence: median(accepted.map((sample) => sample.confidence)),
  pass:
    (samples.length > 0 ? matches.length / samples.length : 0) >= 0.8 &&
    accepted.every((sample) => sample.contributors >= 2),
};
const report = { summary, samples };
await writeJson(outPath, report);
console.log(JSON.stringify(report, null, 2));
process.exit(summary.pass ? 0 : 1);

function stats(values) {
  if (values.length === 0) return { min: null, median: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}

function median(values) {
  return stats(values.filter(Number.isFinite)).median;
}
