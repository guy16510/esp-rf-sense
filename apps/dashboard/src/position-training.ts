import type { PortableModelBundle } from './contracts.js';
import type { PositionTarget } from './position-training-types.js';

export interface TrainedDashboardModel {
  bundle: PortableModelBundle;
  summary: {
    path: string;
    target: PositionTarget;
    classes: string[];
    recordings: number;
    windows: number;
    window: number;
    trainedAt: string;
    validation: PortableModelBundle['validation'];
  };
}
