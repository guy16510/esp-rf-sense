import type { AlignedPacket, ReceiverObservation, ReceiverSlot } from './joint-packet-aligner.js';

export const JOINT_XY_FEATURE_VERSION = 1;
export const JOINT_XY_SLOTS: readonly ReceiverSlot[] = ['A', 'B', 'C', 'D'];
const SUMMARY_BINS = 8;

export interface JointXYFeatureQuality {
  receiverCount: number;
  packetOverlap: number;
  completePacketRatio: number;
  windowPackets: number;
}

export function buildJointXYFeatures(alignedWindow: readonly AlignedPacket[]): number[] {
  if (alignedWindow.length === 0) throw new Error('aligned XY window is empty');
  const features: number[] = [];
  const receiverDisturbance = new Map<ReceiverSlot, number>();
  const receiverRssi = new Map<ReceiverSlot, number>();

  for (const slot of JOINT_XY_SLOTS) {
    const observations = alignedWindow
      .map((packet) => packet.observations[slot])
      .filter((value): value is ReceiverObservation => value !== null);
    const rssi = observations.map((item) => item.rssi);
    const amplitudes = observations.map((item) => csiAmplitude(item));
    const amplitudeMeans = amplitudes.map((item) => average(item));
    const amplitudeDeviation = amplitudes.map((item) => deviation(item));
    const temporalChange = adjacentMeanDelta(amplitudes);
    const summary = stableSubcarrierSummary(amplitudes);
    const present = observations.length > 0 ? 1 : 0;
    const overlap = observations.length / alignedWindow.length;
    const meanRssi = average(rssi);
    const meanDisturbance = average(amplitudeDeviation) + temporalChange;

    receiverRssi.set(slot, meanRssi);
    receiverDisturbance.set(slot, meanDisturbance);
    features.push(
      meanRssi,
      deviation(rssi),
      slope(rssi),
      average(amplitudeMeans),
      deviation(amplitudeMeans),
      temporalChange,
      ...summary,
      overlap,
      present,
      missingRunFraction(alignedWindow, slot),
      receiverTimestampJitter(observations),
    );
  }

  for (let left = 0; left < JOINT_XY_SLOTS.length; left += 1) {
    for (let right = left + 1; right < JOINT_XY_SLOTS.length; right += 1) {
      const a = JOINT_XY_SLOTS[left]!;
      const b = JOINT_XY_SLOTS[right]!;
      features.push(
        (receiverRssi.get(a) ?? 0) - (receiverRssi.get(b) ?? 0),
        (receiverDisturbance.get(a) ?? 0) - (receiverDisturbance.get(b) ?? 0),
      );
    }
  }

  const quality = jointXYFeatureQuality(alignedWindow);
  features.push(
    quality.receiverCount,
    quality.packetOverlap,
    quality.completePacketRatio,
    quality.windowPackets,
    ...JOINT_XY_SLOTS.map((slot) => (alignedWindow.some((packet) => packet.observations[slot]) ? 1 : 0)),
    averagePacketLatencyMs(alignedWindow),
    transmitterSequenceContinuity(alignedWindow),
  );
  return features.map((value) => (Number.isFinite(value) ? Number(value.toFixed(8)) : 0));
}

export function jointXYFeatureQuality(alignedWindow: readonly AlignedPacket[]): JointXYFeatureQuality {
  if (alignedWindow.length === 0) {
    return { receiverCount: 0, packetOverlap: 0, completePacketRatio: 0, windowPackets: 0 };
  }
  const slotCoverage = JOINT_XY_SLOTS.map(
    (slot) => alignedWindow.filter((packet) => packet.observations[slot]).length / alignedWindow.length,
  );
  const receiverCount = slotCoverage.filter((value) => value > 0).length;
  const packetOverlap =
    alignedWindow.reduce((sum, packet) => sum + packet.receiverCount / JOINT_XY_SLOTS.length, 0) /
    alignedWindow.length;
  const completePacketRatio =
    alignedWindow.filter((packet) => packet.receiverCount === JOINT_XY_SLOTS.length).length /
    alignedWindow.length;
  return { receiverCount, packetOverlap, completePacketRatio, windowPackets: alignedWindow.length };
}

function csiAmplitude(observation: ReceiverObservation): number[] {
  const raw = observation.firstWordInvalid
    ? observation.csi.subarray(Math.min(4, observation.csi.length))
    : observation.csi;
  const values: number[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    values.push(Math.hypot(signedByte(raw[index + 1]!), signedByte(raw[index]!)));
  }
  return values;
}

function stableSubcarrierSummary(rows: readonly number[][]): number[] {
  if (rows.length === 0) return Array(SUMMARY_BINS).fill(0) as number[];
  const width = Math.min(...rows.map((row) => row.length).filter((value) => value > 0));
  if (!Number.isFinite(width) || width <= 0) return Array(SUMMARY_BINS).fill(0) as number[];
  const start = Math.floor(width * 0.15);
  const end = Math.max(start + 1, Math.floor(width * 0.85));
  const output: number[] = [];
  for (let bin = 0; bin < SUMMARY_BINS; bin += 1) {
    const left = start + Math.floor(((end - start) * bin) / SUMMARY_BINS);
    const right = start + Math.max(1, Math.floor(((end - start) * (bin + 1)) / SUMMARY_BINS));
    output.push(average(rows.flatMap((row) => row.slice(left, right))));
  }
  return output;
}

function adjacentMeanDelta(rows: readonly number[][]): number {
  if (rows.length < 2) return 0;
  const deltas: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    const width = Math.min(previous.length, current.length);
    for (let column = 0; column < width; column += 1) {
      deltas.push(Math.abs(current[column]! - previous[column]!));
    }
  }
  return average(deltas);
}

function missingRunFraction(window: readonly AlignedPacket[], slot: ReceiverSlot): number {
  let longest = 0;
  let current = 0;
  for (const packet of window) {
    if (packet.observations[slot]) current = 0;
    else {
      current += 1;
      longest = Math.max(longest, current);
    }
  }
  return window.length > 0 ? longest / window.length : 0;
}

function receiverTimestampJitter(observations: readonly ReceiverObservation[]): number {
  if (observations.length < 2) return 0;
  const deltas: number[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    deltas.push(observations[index]!.receiverTimestampUs - observations[index - 1]!.receiverTimestampUs);
  }
  return deviation(deltas);
}

function averagePacketLatencyMs(window: readonly AlignedPacket[]): number {
  return average(window.map((packet) => packet.finalizedAtMs - packet.firstReceivedAtMs));
}

function transmitterSequenceContinuity(window: readonly AlignedPacket[]): number {
  if (window.length < 2) return 1;
  let contiguous = 0;
  for (let index = 1; index < window.length; index += 1) {
    if (((window[index]!.transmitterPacketSeq - window[index - 1]!.transmitterPacketSeq) >>> 0) === 1) {
      contiguous += 1;
    }
  }
  return contiguous / (window.length - 1);
}

function signedByte(value: number): number {
  return value > 127 ? value - 256 : value;
}

function slope(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const x = index - xMean;
    numerator += x * (values[index]! - yMean);
    denominator += x * x;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function deviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
