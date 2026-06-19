import { readFile, writeFile } from 'node:fs/promises';
import type { XYModel } from './simulated-xy-pipeline.js';

export const XY_MODEL_FORMAT = 'rfsense-xy-model/1';

export async function loadXYModel(path: string): Promise<XYModel> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<XYModel>;
  if (!Array.isArray(parsed.examples) || parsed.examples.length < 8) throw new Error('XY model requires at least eight examples');
  if (!Array.isArray(parsed.featureMean) || !Array.isArray(parsed.featureScale)) throw new Error('XY model normalization is missing');
  if (parsed.featureMean.length === 0 || parsed.featureMean.length !== parsed.featureScale.length) throw new Error('XY model normalization width mismatch');
  if (parsed.examples.some((item) => !Array.isArray(item.features) || item.features.length !== parsed.featureMean!.length)) throw new Error('XY model feature width mismatch');
  if (!Number.isFinite(parsed.densityThreshold) || !Number.isFinite(parsed.uncertaintyThreshold)) throw new Error('XY model thresholds are invalid');
  return parsed as XYModel;
}

export async function saveXYModel(path: string, model: XYModel): Promise<void> {
  await writeFile(path, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
}
