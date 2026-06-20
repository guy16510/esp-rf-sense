#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { scorePlacement } from './placement-score.mjs';

const path = process.argv[2] ?? 'config/hardware-room.json';
const room = JSON.parse(await readFile(path, 'utf8'));
const points = ['A', 'B', 'C', 'D'].map((slot) => room.receivers?.[slot]).filter(Boolean);
const result = scorePlacement(points, Number(room.widthMeters), Number(room.heightMeters));
console.log(JSON.stringify({ room: room.name ?? path, ...result }, null, 2));
if (!result.pass) process.exitCode = 1;
