import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContinuousXYExample } from './continuous-xy-model.js';
import { buildJointXYFeatures, jointXYFeatureQuality } from './joint-xy-features.js';
import { JointPacketAligner, type AlignedPacket, type ReceiverObservation, type ReceiverSlot } from './joint-packet-aligner.js';

interface ContinuousXYRecordingMeta {
  name: string;
  complete: boolean;
  target?: string;
  label: string;
  recordingId?: string;
  subjectId?: string;
  day?: string;
  movement?: string;
  orientationDegrees?: number;
  xMeters?: number;
  yMeters?: number;
}

interface ProtocolV2JsonLine {
  protocolVersion: 2;
  recvUnixMs: number;
  source?: { address?: string; port?: number };
  receiverFrameSeq: number;
  receiverTimestampUs: string | number;
  transmitterId: number;
  transmitterBootId: number;
  transmitterPacketSeq: number;
  rssi: number;
  noiseFloor?: number;
  channel: number;
  bandwidthMhz: number;
  firstWordInvalid: boolean;
  csiBase64: string;
}

export interface BuildContinuousXYDatasetOptions {
  recordingsDir: string;
  sourceMappings: Record<ReceiverSlot, { address?: string; port?: number; deviceId: string }>;
  windowPackets: number;
  stepPackets: number;
}

export async function buildContinuousXYDataset(
  options: BuildContinuousXYDatasetOptions,
): Promise<ContinuousXYExample[]> {
  const names = await readdir(options.recordingsDir);
  const metas = await Promise.all(
    names
      .filter((name) => name.endsWith('.meta.json'))
      .map(async (name) => JSON.parse(await readFile(join(options.recordingsDir, name), 'utf8')) as ContinuousXYRecordingMeta),
  );
  const examples: ContinuousXYExample[] = [];
  for (const meta of metas) {
    if (!meta.complete || meta.target !== 'continuous-xy') continue;
    const empty = /empty|clear/iu.test(meta.label) || meta.movement === 'empty';
    if (!empty && (!Number.isFinite(meta.xMeters) || !Number.isFinite(meta.yMeters))) {
      throw new Error(`${meta.name} is missing continuous XY meter coordinates`);
    }
    const aligned = await alignedPacketsForRecording(
      join(options.recordingsDir, `${meta.name}.jsonl`),
      options.sourceMappings,
    );
    const windowPackets = Math.max(1, Math.floor(options.windowPackets));
    const stepPackets = Math.max(1, Math.floor(options.stepPackets));
    for (let start = 0; start + windowPackets <= aligned.length; start += stepPackets) {
      const window = aligned.slice(start, start + windowPackets);
      const quality = jointXYFeatureQuality(window);
      if (quality.receiverCount < 3) continue;
      examples.push({
        xMeters: empty ? 0 : Number(meta.xMeters),
        yMeters: empty ? 0 : Number(meta.yMeters),
        features: buildJointXYFeatures(window),
        recordingId: String(meta.recordingId ?? meta.name),
        subjectId: String(meta.subjectId ?? (empty ? 'empty-room' : 'unknown-subject')),
        day: String(meta.day ?? ''),
        orientationDegrees: Number(meta.orientationDegrees ?? 0),
        movement: String(meta.movement ?? (empty ? 'empty' : 'stationary')),
        receiverCount: quality.receiverCount,
        packetOverlap: quality.packetOverlap,
        empty,
      });
    }
  }
  return examples;
}

async function alignedPacketsForRecording(
  jsonlPath: string,
  sourceMappings: BuildContinuousXYDatasetOptions['sourceMappings'],
): Promise<AlignedPacket[]> {
  const aligner = new JointPacketAligner(75, 8192);
  const packets: AlignedPacket[] = [];
  const lines = (await readFile(jsonlPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    const parsed = JSON.parse(line) as ProtocolV2JsonLine;
    if (parsed.protocolVersion !== 2) continue;
    const mapped = slotForSource(parsed.source ?? {}, sourceMappings);
    if (!mapped) continue;
    const observation: ReceiverObservation = {
      receiverSlot: mapped.slot,
      receiverDeviceId: mapped.deviceId,
      receiverBootId: `${mapped.deviceId}:${parsed.source?.address ?? ''}:${parsed.source?.port ?? ''}`,
      receiverFrameSeq: parsed.receiverFrameSeq,
      receiverTimestampUs: Number(parsed.receiverTimestampUs),
      transmitterId: String(parsed.transmitterId),
      transmitterBootId: String(parsed.transmitterBootId),
      transmitterPacketSeq: parsed.transmitterPacketSeq,
      rssi: parsed.rssi,
      ...(parsed.noiseFloor !== undefined ? { noiseFloor: parsed.noiseFloor } : {}),
      channel: parsed.channel,
      bandwidthMhz: parsed.bandwidthMhz,
      firstWordInvalid: parsed.firstWordInvalid,
      csi: Buffer.from(parsed.csiBase64, 'base64'),
      receivedAtMs: parsed.recvUnixMs,
    };
    packets.push(...aligner.add(observation).filter((packet) => packet.receiverCount >= 3));
  }
  packets.push(...aligner.expire(Number.POSITIVE_INFINITY).filter((packet) => packet.receiverCount >= 3));
  return packets;
}

function slotForSource(
  source: { address?: string; port?: number },
  sourceMappings: BuildContinuousXYDatasetOptions['sourceMappings'],
): { slot: ReceiverSlot; deviceId: string } | null {
  for (const [slot, mapping] of Object.entries(sourceMappings) as Array<[ReceiverSlot, { address?: string; port?: number; deviceId: string }]>) {
    if (mapping.address !== undefined && mapping.address !== source.address) continue;
    if (mapping.port !== undefined && mapping.port !== source.port) continue;
    return { slot, deviceId: mapping.deviceId };
  }
  return null;
}
