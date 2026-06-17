export type ActivityState = 'waiting' | 'clear' | 'active';
export type DataSource = 'real' | 'replay' | 'simulated';

export interface ActivityBubble {
  id: string;
  x: number;
  y: number;
  radius: number;
  confidence: number;
  motion: number;
  zone: string | null;
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
  source: DataSource;
  averageRssi: number | null;
  csiLength: number;
  subcarrierCount: number;
  missingPackets: number;
  ready: boolean;
}

export interface LabReadiness {
  source: DataSource;
  readyForCapture: boolean;
  requiredNodeCount: number;
  onlineNodeCount: number;
  reasons: string[];
}

export interface MultiNodeState {
  timestamp: number;
  source: DataSource;
  readiness: LabReadiness;
  nodes: DashboardState[];
  fused: {
    state: ActivityState;
    confidence: number | null;
    motion: number;
    contributingNodes: string[];
    excludedNodes: Array<{ deviceId: string; reason: string }>;
    disagreement: number;
  };
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
