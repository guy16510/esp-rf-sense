// Exports a recorded .jsonl to a flat CSV (one row per frame) for quick inspection in a
// spreadsheet. CSI bytes are kept as base64 in a single column -- the analysis pipeline reads the
// authoritative .csi.bin, so this CSV is for metadata triage, not signal processing.
//
//   npm run export:csv -- --in data/run-01.jsonl --out data/run-01.csv
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { parseArgs, flagStr } from './args.js';

const COLUMNS = [
  'recvUnixMs',
  'deviceId',
  'bootId',
  'packetSeq',
  'batchSeq',
  'captureMode',
  'flags',
  'frameSeq',
  'timestampUs',
  'pingSeq',
  'rssi',
  'noiseFloor',
  'channel',
  'secondaryChannel',
  'bandwidth',
  'phyMode',
  'rate',
  'firstWordInvalid',
  'linkId',
  'csiLen',
  'csiBase64',
] as const;

interface JsonlFrame {
  frameSeq: number;
  timestampUs: number;
  pingSeq: number;
  rssi: number;
  noiseFloor: number;
  channel: number;
  secondaryChannel: number;
  bandwidth: number;
  phyMode: number;
  rate: number;
  firstWordInvalid: number;
  linkId: number;
  csiLen: number;
  csiBase64: string;
}
interface JsonlLine {
  recvUnixMs: number;
  deviceId: number;
  bootId: number;
  packetSeq: number;
  batchSeq: number;
  captureMode: number;
  flags: number;
  frames: JsonlFrame[];
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const inPath = flagStr(flags, 'in', undefined);
  const outPath = flagStr(flags, 'out', undefined);
  if (!inPath || !outPath) {
    console.error('usage: export:csv -- --in <recording>.jsonl --out <file>.csv');
    process.exit(2);
  }

  const out = createWriteStream(outPath);
  out.write(`${COLUMNS.join(',')}\n`);
  const rl = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity });

  let frames = 0;
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as JsonlLine;
    for (const f of line.frames) {
      const row = [
        line.recvUnixMs,
        line.deviceId,
        line.bootId,
        line.packetSeq,
        line.batchSeq,
        line.captureMode,
        line.flags,
        f.frameSeq,
        f.timestampUs,
        f.pingSeq,
        f.rssi,
        f.noiseFloor,
        f.channel,
        f.secondaryChannel,
        f.bandwidth,
        f.phyMode,
        f.rate,
        f.firstWordInvalid,
        f.linkId,
        f.csiLen,
        f.csiBase64,
      ].map(csvCell);
      out.write(`${row.join(',')}\n`);
      frames++;
    }
  }
  await new Promise<void>((resolve, reject) =>
    out.end((e?: Error | null) => (e ? reject(e) : resolve())),
  );
  console.error(`[export-csv] wrote ${frames} frame rows to ${outPath}`);
}

main().catch((err) => {
  console.error(`[export-csv] fatal: ${(err as Error).message}`);
  process.exit(1);
});
