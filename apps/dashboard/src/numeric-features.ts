import type { CsiFrame } from './protocol.js';

export function decodeAmplitude(frame: CsiFrame): Float64Array {
  const raw = frame.firstWordInvalid
    ? frame.csi.subarray(Math.min(4, frame.csi.length))
    : frame.csi;
  const output = new Float64Array(Math.floor(raw.length / 2));
  for (let index = 0; index < output.length; index++) {
    output[index] = Math.hypot(raw.readInt8(index * 2 + 1), raw.readInt8(index * 2));
  }
  return output;
}

export function motionLevel(frames: readonly Float64Array[]): number {
  if (frames.length < 2) return 0;
  const width = frames[0]?.length ?? 0;
  const values: number[] = [];
  for (let row = 1; row < frames.length; row++) {
    for (let column = 0; column < width; column++) {
      values.push(Math.abs(frames[row]![column]! - frames[row - 1]![column]!));
    }
  }
  return average(values);
}

export function amplitudeProfile(frames: readonly Float64Array[], limit = 8): number[] {
  const selected = frames.slice(-limit);
  const width = selected[0]?.length ?? 0;
  return Array.from({ length: width }, (_, column) =>
    Number(average(selected.map((frame) => frame[column] ?? 0)).toFixed(3)),
  );
}

export function windowFeatures(frames: readonly Float64Array[]): number[] {
  if (frames.length < 2) throw new Error('at least two frames are required');
  const width = frames[0]?.length ?? 0;
  if (width === 0 || frames.some((frame) => frame.length !== width)) {
    throw new Error('frames must share a non-zero width');
  }
  const means = Array.from({ length: width }, (_, column) =>
    average(frames.map((frame) => frame[column]!)),
  );
  const deviations = Array.from({ length: width }, (_, column) =>
    Math.sqrt(average(frames.map((frame) => (frame[column]! - means[column]!) ** 2))),
  );
  const differences: number[] = [];
  for (let row = 1; row < frames.length; row++) {
    for (let column = 0; column < width; column++) {
      differences.push(Math.abs(frames[row]![column]! - frames[row - 1]![column]!));
    }
  }
  return [
    ...means,
    ...deviations,
    average(differences),
    Math.max(...differences),
    average(deviations),
    median(deviations),
    Math.max(...deviations),
    0,
  ];
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
