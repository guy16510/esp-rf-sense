import { decodeRecordedAmplitude, dominantAmplitudeWidth } from './position-amplitude.js';
import { readRecordedPositionDatagrams } from './position-jsonl.js';
import { buildPositionWindows } from './position-windowing.js';

export async function readReceiverWindows(
  path: string,
  window: number,
  step: number,
): Promise<number[][]> {
  const streams = new Map<number, Float64Array[]>();
  for (const datagram of await readRecordedPositionDatagrams(path)) {
    const frames = streams.get(datagram.deviceId) ?? [];
    for (const frame of datagram.frames) frames.push(decodeRecordedAmplitude(frame));
    streams.set(datagram.deviceId, frames);
  }
  return [...streams.values()]
    .map(dominantAmplitudeWidth)
    .filter((frames) => frames.length > 0)
    .flatMap((frames) => buildPositionWindows(frames, window, step));
}
