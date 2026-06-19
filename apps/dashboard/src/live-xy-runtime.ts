import { JointPacketAligner, type ReceiverObservation, type ReceiverSlot } from './joint-packet-aligner.js';
import { decodeCsiFrameV2 } from './protocol-v2.js';
import { predictXY, type XYPrediction, type XYModel, type XYTrainingExample } from './simulated-xy-pipeline.js';

export interface UdpSource { address: string; port: number }
export interface ReceiverSourceMapping { slot: ReceiverSlot; address?: string; port?: number; deviceId: string }

export class LiveXYRuntime {
  private readonly aligner = new JointPacketAligner(75, 4096);
  private prediction: XYPrediction | null = null;
  private rejectedSources = 0;
  private decodeErrors = 0;

  constructor(private readonly model: XYModel, private readonly mappings: ReceiverSourceMapping[]) {
    if (new Set(mappings.map((item) => item.slot)).size !== mappings.length) throw new Error('duplicate receiver slot');
    if (mappings.length < 3) throw new Error('at least three receiver mappings are required');
  }

  acceptDatagram(input: Buffer, source: UdpSource, receivedAtMs = Date.now()): XYPrediction[] {
    const mapping = this.mappings.find((item) => (item.address === undefined || item.address === source.address) && (item.port === undefined || item.port === source.port));
    if (!mapping) { this.rejectedSources += 1; return []; }
    let frame;
    try { frame = decodeCsiFrameV2(input); } catch { this.decodeErrors += 1; return []; }
    const observation: ReceiverObservation = {
      receiverSlot: mapping.slot,
      receiverDeviceId: mapping.deviceId,
      receiverBootId: `${mapping.deviceId}:${source.address}:${source.port}`,
      receiverFrameSeq: frame.receiverFrameSeq,
      receiverTimestampUs: Number(frame.receiverTimestampUs),
      transmitterId: String(frame.transmitterId),
      transmitterBootId: String(frame.transmitterBootId),
      transmitterPacketSeq: frame.transmitterPacketSeq,
      rssi: frame.rssi,
      noiseFloor: frame.noiseFloor,
      channel: frame.channel,
      bandwidthMhz: frame.bandwidthMhz,
      firstWordInvalid: frame.firstWordInvalid,
      csi: frame.csi,
      receivedAtMs,
    };
    return this.aligner.add(observation).map((packet) => {
      const slots: ReceiverSlot[] = ['A', 'B', 'C', 'D'];
      const features = slots.flatMap((slot) => {
        const value = packet.observations[slot];
        if (!value) return [0, 0, 0, 0, 0];
        const samples = Array.from(value.csi, (byte) => byte > 127 ? byte - 256 : byte);
        const mean = samples.reduce((sum, sample) => sum + Math.abs(sample), 0) / Math.max(1, samples.length);
        const peak = samples.reduce((result, sample) => Math.max(result, Math.abs(sample)), 0);
        return [value.rssi, mean, peak, value.csi.length, 1];
      });
      const rssi = slots.map((_slot, index) => features[index * 5] ?? 0);
      features.push(rssi[0]! - rssi[1]!, rssi[0]! - rssi[2]!, rssi[0]! - rssi[3]!, rssi[1]! - rssi[2]!, rssi[1]! - rssi[3]!, rssi[2]! - rssi[3]!);
      const example: XYTrainingExample = { xMeters: 0, yMeters: 0, features, recordingId: `live-${packet.transmitterPacketSeq}`, subjectId: 'live', day: 'live', orientationDegrees: 0, receiverCount: packet.receiverCount, packetOverlap: packet.receiverCount / 4, empty: false };
      this.prediction = predictXY(this.model, example);
      return this.prediction;
    });
  }

  snapshot() { return { prediction: this.prediction, rejectedSources: this.rejectedSources, decodeErrors: this.decodeErrors, mappings: this.mappings, alignment: this.aligner.metrics() }; }
}
