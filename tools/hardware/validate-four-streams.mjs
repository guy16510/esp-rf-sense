#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import {
  argNumber,
  artifactPath,
  DEFAULT_DASHBOARD_URL,
  fetchDashboardNodes,
  parseArgs,
  streamReport,
  writeJson,
} from './hardware-common.mjs';

const { values } = parseArgs(process.argv.slice(2));
const dashboardUrl = values.get('dashboard-url') ?? DEFAULT_DASHBOARD_URL;
const durationSeconds = argNumber(values, 'duration', 30);
const intervalMs = argNumber(values, 'interval-ms', 500);
const outPath = values.get('out') ?? artifactPath('four-stream-report.json');
const samples = [];
const started = Date.now();

while (Date.now() - started < durationSeconds * 1000) {
  samples.push(await fetchDashboardNodes(dashboardUrl));
  await delay(intervalMs);
}

const report = streamReport(samples, {
  minFrameRateHz: argNumber(values, 'min-frame-rate', 5),
  maxAgeSec: argNumber(values, 'max-age-sec', 1),
  maxLossPpm: argNumber(values, 'max-loss-ppm', 100000),
});
await writeJson(outPath, report);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
