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

export interface DashboardState {
  timestamp: number;
  state: ActivityState;
  confidence: number;
  motion: number;
  zone: string | null;
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
  mode: 'heuristic' | 'portable-model';
  scores: Record<string, number>;
  diagnostics: ActivityDiagnostics;
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
}
