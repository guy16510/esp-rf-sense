export type ActivityState = 'waiting' | 'baseline' | 'clear' | 'active';

export interface ActivityBubble {
  id: string;
  x: number;
  y: number;
  radius: number;
  confidence: number;
  motion: number;
  zone: string | null;
}

export interface ActivityDiagnostics {
  baselineReady: boolean;
  baselineSamples: number;
  baselineRequired: number;
  baselineProgress: number;
  baselineMean: number | null;
  baselineDeviation: number;
  activationScore: number;
  activeStreak: number;
  clearStreak: number;
}

export interface PositionEstimate {
  accepted: boolean;
  zone: string | null;
  x: number | null;
  y: number | null;
  confidence: number;
  margin: number;
  contributors: number;
  agreement: number;
  reason: string | null;
}

export interface DashboardState {
  timestamp: number;
  state: ActivityState;
  confidence: number;
  motion: number;
  zone: string | null;
  position: PositionEstimate | null;
  bubbles: ActivityBubble[];
  amplitudeProfile: number[];
  frameRateHz: number;
  lossPpm: number;
  ageSec: number | null;
  deviceId: string | null;
  bootId: string | null;
  frames: number;
  datagrams: number;
  invalidDatagrams: number;
  mode: 'heuristic' | 'portable-model' | 'fused';
  modelTarget?: 'presence' | 'label' | 'position';
  scores: Record<string, number>;
  diagnostics: ActivityDiagnostics;
  source?: 'real' | 'replay' | 'simulated';
  name?: string;
  expected?: boolean;
  averageRssi?: number | null;
  csiLength?: number;
  subcarrierCount?: number;
  missingPackets?: number;
  duplicatePackets?: number;
  outOfOrderPackets?: number;
  ready?: boolean;
  readinessReasons?: string[];
}

export interface CampaignMarker {
  id: number;
  type: 'campaign_start' | 'campaign_end' | 'interaction' | 'note';
  label: string;
  campaignId: string;
  timestamp: number;
}

export interface DeviceLogEntry {
  sequence: number;
  uptimeMs: number;
  line: string;
}

export interface DeviceTelemetry {
  connected: boolean;
  lastUpdated: number | null;
  error: string | null;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
}

export interface ValidationMetric {
  protocol: 'leave-one-recording-out' | 'leave-one-person-out' | 'leave-one-day-out' | 'leave-one-position-out';
  status: 'pass' | 'fail' | 'not-applicable' | 'diagnostic';
  folds: number;
  samples: number;
  accuracy: number | null;
  unknownRejection: number | null;
  note: string;
}

export interface ModelValidationReport {
  leakageSafe: true;
  generatedAt: string;
  metrics: ValidationMetric[];
  warnings: string[];
}

export interface PortableModelBundle {
  format: 'rfsense-portable-model/1';
  target: 'presence' | 'label' | 'position';
  window: number;
  nFeatures: number;
  classes: string[];
  featureMean: number[];
  featureScale: number[];
  prototypes: Record<string, number[]>;
  zones: Record<string, { x: number | null; y: number | null }>;
  temperature?: number;
  confidenceThreshold?: number;
  marginThreshold?: number;
  distanceThreshold?: number;
  validation?: ModelValidationReport;
}
