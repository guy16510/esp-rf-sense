import { createSocket } from 'node:dgram';
import { JointPositionEngine } from './joint-position-engine.js';
import { LiveXYRuntime } from './live-xy-runtime.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import { loadXYModel } from './xy-model-store.js';

const modelPath = process.env.RF_XY_MODEL;
if (!modelPath) throw new Error('RF_XY_MODEL is required');
const model = await loadXYModel(modelPath);
const readNumber = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);
const engine = new JointPositionEngine(
  { requiredNodeCount: 4 },
  readNumber('RF_ROOM_WIDTH_M', 4),
  readNumber('RF_ROOM_HEIGHT_M', 4),
);
const slots = ['A', 'B', 'C', 'D'] as const;
const mappings = slots.map((slot, index) => ({
  slot,
  deviceId: `rx-${slot.toLowerCase()}`,
  port: readNumber(`RF_SLOT_${slot}_PORT`, 6101 + index),
}));
const runtime = new LiveXYRuntime(model, mappings);
export const runtimeVersion = 1;
