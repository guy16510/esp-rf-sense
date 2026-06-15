// The OTA manifest shape. Mirrors firmware/components/ota_manager/include/OtaManifest.h and the
// generator firmware/tools/gen_manifest.py. Keep all three in sync.
export const SCHEMA_VERSION = 1;
export const EXPECTED_PROJECT = 'rf-sense';
export const EXPECTED_TARGET = 'esp32s3';
export const EXPECTED_BOARD = 'esp32-s3-wroom-1-n4r8';
export const OTA_SLOT_SIZE = 0x1f0000; // one app slot from firmware/partitions.csv (2,031,616 B)
export const FLASH_SIZE = 4 * 1024 * 1024;

export type Channel = 'stable' | 'development';

export interface Manifest {
  schemaVersion: number;
  project: string;
  channel: Channel;
  version: string;
  buildId: string;
  target: string;
  board: string;
  flashSizeBytes: number;
  appSizeBytes: number;
  sha256: string;
  firmwareUrl: string;
  releasedAt: string;
  minimumCurrentVersion: string;
  mandatory: boolean;
  releaseNotes: string;
}

export function isManifest(v: unknown): v is Manifest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.schemaVersion === 'number' &&
    typeof o.project === 'string' &&
    typeof o.version === 'string' &&
    typeof o.target === 'string' &&
    typeof o.board === 'string' &&
    typeof o.appSizeBytes === 'number' &&
    typeof o.sha256 === 'string' &&
    typeof o.firmwareUrl === 'string'
  );
}
