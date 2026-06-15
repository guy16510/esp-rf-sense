// Experiment metadata schema. Every recording must be fully self-describing so that, months
// later, a dataset can be re-analyzed without guessing. Fields that the analysis pipeline needs
// for honest, leakage-free evaluation -- subjectId, position, day -- are first-class, because the
// classical-ML splits are leave-one-{person,position,day}-out.
//
// Body measurements are explicitly OPTIONAL and explicitly EXPERIMENTAL: any body-size signal is a
// hypothesis to be rejected if it fails to generalize, never an assumed capability.

export type CaptureMode = 'controlled' | 'normal' | 'passive';
export type Movement = 'none' | 'stationary' | 'walking' | 'mixed';

export interface Position {
  // Free-form room-relative label plus optional metric coordinates (meters from a fixed origin).
  label: string;
  x?: number;
  y?: number;
  z?: number;
}

export interface BodyMeasurements {
  // EXPERIMENTAL. Recorded only with subject consent; never used to make claims unless it survives
  // leave-one-person-out validation.
  heightCm?: number;
  weightKg?: number;
  note?: string;
}

export interface SubjectInfo {
  count: number; // number of people in the space (0 = empty baseline)
  subjectIds: string[]; // stable pseudonymous ids, one per person, for leave-one-person-out CV
  movement: Movement;
  position?: Position;
  orientation?: string; // e.g. "facing TX", "perpendicular"
  body?: BodyMeasurements[];
}

export interface LinkInfo {
  txDescription: string; // the router/AP acting as transmitter
  txPosition?: Position;
  rxPosition?: Position; // the ESP32-S3 receiver
  channel: number;
  pingPps: number;
}

export interface DeviceSnapshot {
  deviceId: string; // hex, e.g. "a1b2c3d4"
  deviceName: string;
  firmwareVersion: string;
  gitCommit: string;
  bootId: number;
  target: string;
  board: string;
  protocolVersion: number;
}

export interface CaptureCounts {
  // Filled in at stop from collector stats + device health, so loss is part of the record.
  validDatagrams?: number;
  invalidDatagrams?: number;
  framesReceived?: number;
  reboots?: number;
  collectorPacketLossPpm?: number;
  deviceCsiQueueDrops?: number;
  deviceNetworkQueueDrops?: number;
}

export interface ExperimentMetadata {
  schemaVersion: 1;
  experimentId: string; // groups related sessions, e.g. "occupancy-room-A"
  sessionId: string; // unique per recording
  group: string; // template id this session belongs to (see templates.ts)
  label: string; // ground-truth class for supervised learning, e.g. "occupied", "empty"
  room: string;
  day: string; // YYYY-MM-DD, used for leave-one-day-out CV
  captureMode: CaptureMode;
  link: LinkInfo;
  subject: SubjectInfo;
  recordingName: string; // collector recording basename
  startedAt: string; // ISO-8601
  endedAt?: string;
  complete: boolean; // false until the collector exits cleanly and final counts are written
  failureReason?: string;
  device?: DeviceSnapshot;
  counts?: CaptureCounts;
  notes: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateMetadata(m: Partial<ExperimentMetadata>): ValidationResult {
  const errors: string[] = [];
  const req = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
  };

  req(m.schemaVersion === 1, 'schemaVersion must be 1');
  req(!!m.experimentId, 'experimentId is required');
  req(!!m.sessionId, 'sessionId is required');
  req(!!m.group, 'group is required');
  req(!!m.label, 'label is required (ground-truth class)');
  req(!!m.room, 'room is required');
  req(!!m.day && /^\d{4}-\d{2}-\d{2}$/.test(m.day), 'day must be YYYY-MM-DD');
  req(
    m.captureMode === 'controlled' || m.captureMode === 'normal' || m.captureMode === 'passive',
    'captureMode must be controlled|normal|passive',
  );
  req(!!m.link, 'link info is required');
  if (m.link) {
    req(Number.isFinite(m.link.channel), 'link.channel is required');
    req(Number.isFinite(m.link.pingPps), 'link.pingPps is required');
    req(!!m.link.txDescription, 'link.txDescription is required');
  }
  req(!!m.subject, 'subject info is required');
  if (m.subject) {
    req(Number.isInteger(m.subject.count) && m.subject.count >= 0, 'subject.count must be >= 0');
    req(Array.isArray(m.subject.subjectIds), 'subject.subjectIds must be an array');
    if (
      m.subject.count > 0 &&
      m.subject.subjectIds &&
      m.subject.subjectIds.length !== m.subject.count
    ) {
      errors.push('subject.subjectIds length must equal subject.count for non-empty sessions');
    }
  }
  req(!!m.recordingName, 'recordingName is required');
  req(!!m.startedAt, 'startedAt is required');
  req(typeof m.complete === 'boolean', 'complete must be true or false');
  if (m.complete) {
    req(!!m.endedAt, 'endedAt is required for complete sessions');
  }

  return { ok: errors.length === 0, errors };
}
