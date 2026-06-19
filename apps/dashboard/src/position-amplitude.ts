import type { RecordedPositionFrame } from './position-jsonl.js';

export function decodeRecordedAmplitude(frame: RecordedPositionFrame): Float64Array {
  const content = Buffer.from(frame.csiBase64, 'base64');
  const raw = frame.firstWordInvalid ? content.subarray(Math.min(4, content.length)) : content;
  const output = new Float64Array(Math.floor(raw.length / 2));
  for (let index = 0; index < output.length; index++) {
    output[index] = Math.hypot(raw.readInt8(index * 2 + 1), raw.readInt8(index * 2));
  }
  return output;
}

export function dominantAmplitudeWidth(frames: readonly Float64Array[]): Float64Array[] {
  const counts = new Map<number, number>();
  for (const frame of frames) counts.set(frame.length, (counts.get(frame.length) ?? 0) + 1);
  let width = 0;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (candidate > 0 && count > best) {
      width = candidate;
      best = count;
    }
  }
  return frames.filter((frame) => frame.length === width);
}
