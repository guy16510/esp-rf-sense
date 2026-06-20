import { JointPacketAligner, type ReceiverObservation, type ReceiverSlot } from './joint-packet-aligner.js';
import { predictContinuousXY, type ContinuousXYModel, type ContinuousXYPrediction } from './continuous-xy-model.js';
import { buildJointXYFeatures, jointXYFeatureQuality } from './joint-xy-features.js';
import { decodeCsiFrameV2 } from './protocol-v2.js';

export interface UdpSource { address: string; port: number }
export interface ReceiverSourceMapping { slot: ReceiverSlot; address?: string; port?: number; deviceId: string }
export interface LiveXYRuntimeOptions {
  windowPackets?: number;
  onPrediction?: (prediction: ContinuousXYPrediction | null) => void;
}

export class LiveXYRuntime {
  private readonly aligner = new JointPacketAligner(75, 4096);
  private readonly alignedWindow: ReturnType<JointPacketAligner['add']> = [];
  private prediction: ContinuousXYPrediction | null = null;
  private rejectedSources = 0;
  private decodeErrors = 0;
  private rejectedAlignedPackets = 0;

  constructor(
    private readonly model: ContinuousXYModel,
    private readonly mappings: ReceiverSourceMapping[],
    private readonly options: LiveXYRuntimeOptions = {},
  ) {
    if (new Set(mappings.map((item) => item.slot)).size !== mappings.length) throw new Error('duplicate receiver slot');
    if (mappings.length < 3) throw new Error('at least three receiver mappings are required');
    const wildcardMappings = mappings.filter((item) => item.address === undefined && item.port === undefined);
    if (mappings.length > 1 && wildcardMappings.length > 1) {
      throw new Error('continuous XY receiver mappings require source address or port constraints');
    }
  }

  acceptDatagram(input: Buffer, source: UdpSource, receivedAtMs = Date.now()): ContinuousXYPrediction[] {
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
      ...(frame.noiseFloor !== undefined ? { noiseFloor: frame.noiseFloor } : {}),
      channel: frame.channel,
      bandwidthMhz: frame.bandwidthMhz,
      firstWordInvalid: frame.firstWordInvalid,
      csi: frame.csi,
      receivedAtMs,
    };
    const predictions: ContinuousXYPrediction[] = [];
    for (const packet of this.aligner.add(observation)) {
      if (packet.receiverCount < 3) {
        this.rejectedAlignedPackets += 1;
        this.prediction = predictContinuousXY(this.model, {
          features: this.model.featureMean,
          receiverCount: packet.receiverCount,
          packetOverlap: packet.receiverCount / 4,
        });
        this.options.onPrediction?.(this.prediction);
        predictions.push(this.prediction);
        continue;
      }
      this.alignedWindow.push(packet);
      const windowPackets = Math.max(1, Math.floor(this.options.windowPackets ?? 24));
      while (this.alignedWindow.length > windowPackets) this.alignedWindow.shift();
      const features = buildJointXYFeatures(this.alignedWindow);
      const quality = jointXYFeatureQuality(this.alignedWindow);
      this.prediction = predictContinuousXY(this.model, {
        features,
        receiverCount: quality.receiverCount,
        packetOverlap: quality.packetOverlap,
        latencyMs: packet.finalizedAtMs - packet.firstReceivedAtMs,
      });
      this.options.onPrediction?.(this.prediction);
      predictions.push(this.prediction);
    }
    return predictions;
  }

  snapshot() { return { prediction: this.prediction, rejectedSources: this.rejectedSources, decodeErrors: this.decodeErrors, rejectedAlignedPackets: this.rejectedAlignedPackets, mappings: this.mappings, alignment: this.aligner.metrics(), windowPackets: this.alignedWindow.length }; }
}
