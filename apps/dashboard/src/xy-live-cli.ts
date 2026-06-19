import { createSocket } from 'node:dgram';
import { JointPositionEngine } from './joint-position-engine.js';
import { LiveXYRuntime } from './live-xy-runtime.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';
import { loadXYModel } from './xy-model-store.js';

const modelPath = process.env.RF_XY_MODEL;
if (!modelPath) throw new Error('RF_XY_MODEL is required');
const model = await loadXYModel(modelPath);
export const runtimeVersion = 1;
