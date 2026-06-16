import type { CsiFrame } from './protocol.js';

export function decodeAmplitude(frame: CsiFrame): Float64Array {
  const raw = frame.firstWordInvalid ? frame.csi.subarray(Math.min(4, frame.csi.length)) : frame.csi;
  const count = Math.floor(raw.length / 2);
  const amplitude = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const imaginary = raw.readInt8(index * 2);
    const real = raw.readInt8(index * 2 + 1);
    amplitude[index] = Math.hypot(real, imaginary);
  }
  return amplitude;
}

export function motionLevel(frames: readonly Float64Array[]): number {
  if (frames.length < 2) return 0;
  const subcarriers = frames[0]?.length ?? 0;
  if (subcarriers === 0) return 0;
  let total = 0;
  let samples = 0;
  for (let row = 1; row < frames.length; row++) {
    const current = frames[row]!;
    const previous = frames[row - 1]!;
    if (current.length !== subcarriers || previous.length !== subcarriers) continue;
    for (let column = 0; column < subcarriers; column++) {
      total += Math.abs(current[column]! - previous[column]!);
      samples++;
    }
  }
  return samples > 0 ? total / samples : 0;
}

export function amplitudeProfile(frames: readonly Float64Array[], limit = 8): number[] {
  if (frames.length === 0) return [];
  const selected = frames.slice(-limit);
  const subcarriers = selected[0]?.length ?? 0;
  const result = new Array<number>(subcarriers).fill(0);
  for (const frame of selected) {
    if (frame.length !== subcarriers) continue;
    for (let index = 0; index < subcarriers; index++) result[index] += frame[index]!;
  }
  return result.map((value) => Number((value / selected.length).toFixed(3)));
}

export function windowFeatures(frames: readonly Float64Array[]): number[] {
  if (frames.length < 2) throw new Error('at least two frames are required');
  const subcarriers = frames[0]?.length ?? 0;
  if (subcarriers === 0) throw new Error('frames contain no subcarriers');
  if (frames.some((frame) => frame.length !== subcarriers)) {
    throw new Error('all frames must have the same subcarrier count');
  }

  const means = new Array<number>(subcarriers).fill(0);
  for (const frame of frames) {
    for (let index = 0; index < subcarriers; index++) means[index] += frame[index]!;
  }
  for (let index = 0; index < subcarriers; index++) means[index] /= frames.length;

  const std = new Array<number>(subcarriers).fill(0);
  for (const frame of frames) {
    for (let index = 0; index < subcarriers; index++) {
      const delta = frame[index]! - means[index]!;
      std[index] += delta * delta;
    }
  }
  for (let index = 0; index < subcarriers; index++) std[index] = Math.sqrt(std[index]! / frames.length);

  let diffSum = 0;
  let diffPeak = 0;
  let diffCount = 0;
  for (let row = 1; row < frames.length; row++) {
    for (let column = 0; column < subcarriers; column++) {
      const delta = Math.abs(frames[row]![column]! - frames[row - 1]![column]!);
      diffSum += delta;
      diffPeak = Math.max(diffPeak, delta);
      diffCount++;
    }
  }

  const activityMean = average(std);
  const activityMedian = median(std);
  const activityMax = Math.max(...std);
  const coherence = averagePairwiseCorrelation(frames, means, std);
  return [
    ...means,
    ...std,
    diffCount > 0 ? diffSum / diffCount : 0,
    diffPeak,
    activityMean,
    activityMedian,
    activityMax,
    coherence,
  ];
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function averagePairwiseCorrelation(
  frames: readonly Float64Array[],
  means: readonly number[],
  std: readonly number[],
): number {
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < means.length; left++) {
    if (std[left]! <= 0) continue;
    for (let right = left + 1; right < means.length; right++) {
      if (std[right]! <= 0) continue;
      let covariance = 0;
      for (const frame of frames) {
        covariance += (frame[left]! - means[left]!) * (frame[right]! - means[right]!);
      }
      covariance /= frames.length;
      total += covariance / (std[left]! * std[right]!);
      pairs++;
    }
  }
  return pairs > 0 ? total / pairs : 0;
}
