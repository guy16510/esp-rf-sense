import type { ContinuousXYModel } from './continuous-xy-model.js';
import { JointPositionEngine } from './joint-position-engine.js';
import { LiveXYRuntime, type ReceiverSourceMapping } from './live-xy-runtime.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';

export interface XYDashboardRuntimeOptions {
  host?: string;
  port?: number;
  intervalMs?: number;
  roomWidthMeters?: number;
  roomHeightMeters?: number;
  modelPath?: string;
}

export function createXYDashboardRuntime(
  model: ContinuousXYModel,
  mappings: ReceiverSourceMapping[],
  options: XYDashboardRuntimeOptions = {},
) {
  const engine = new JointPositionEngine(
    { requiredNodeCount: 4 },
    options.roomWidthMeters ?? 4,
    options.roomHeightMeters ?? 4,
  );
  const runtime = new LiveXYRuntime(model, mappings, {
    onPrediction: (prediction) => engine.setJointPrediction(prediction),
  });
  const dashboard = new MultiNodeDashboardServer(engine, {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    intervalMs: options.intervalMs ?? 50,
    recordingsDir: 'recordings/dashboard',
    modelPath: options.modelPath ?? 'models/xy.json',
    slotDeviceIds: mappings.map((mapping) => mapping.deviceId),
    model: {
      loaded: true,
      path: options.modelPath ?? 'models/xy.json',
      target: 'continuous-xy',
      classes: ['continuous-xy'],
      trainedAt: null,
      recordings: model.examples.length,
      windows: null,
      error: null,
      validatedContinuousXY: model.validation.validatedContinuousXY,
    },
  });
  return { engine, runtime, dashboard };
}
