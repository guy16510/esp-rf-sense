import { windowFeatures } from './features.js';

export function buildPositionWindows(
  frames: readonly Float64Array[],
  window: number,
  step: number,
): number[][] {
  const rows: number[][] = [];
  for (let start = 0; start + window <= frames.length; start += step) {
    rows.push(windowFeatures(frames.slice(start, start + window)));
  }
  return rows;
}
