// Startup validation. The server refuses to come up while any advertised manifest points at a
// firmware image that is missing, the wrong size, the wrong target/board, oversized for the OTA
// slot, or whose SHA-256 does not match the bytes on disk. This makes it impossible to serve an
// update the device will (correctly) reject -- the failure is caught here, loudly, not on the device.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EXPECTED_BOARD,
  EXPECTED_PROJECT,
  EXPECTED_TARGET,
  OTA_SLOT_SIZE,
  SCHEMA_VERSION,
  isManifest,
  type Channel,
  type Manifest,
} from './manifest.js';

export interface ValidationIssue {
  channel: Channel;
  level: 'error' | 'warn';
  message: string;
}

export interface ManifestResult {
  channel: Channel;
  present: boolean;
  manifest?: Manifest;
  firmwarePath?: string;
  issues: ValidationIssue[];
}

// Pure check of a manifest's metadata against the actual firmware bytes. Filesystem-free so it can
// be unit-tested directly.
export function checkManifestAgainstFirmware(
  channel: Channel,
  manifest: unknown,
  firmware: Buffer,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string) => issues.push({ channel, level: 'error', message });
  const warn = (message: string) => issues.push({ channel, level: 'warn', message });

  if (!isManifest(manifest)) {
    err('manifest is missing required fields');
    return issues;
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    err(`schemaVersion ${manifest.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (manifest.project !== EXPECTED_PROJECT)
    err(`project "${manifest.project}" != "${EXPECTED_PROJECT}"`);
  if (manifest.target !== EXPECTED_TARGET)
    err(`target "${manifest.target}" != "${EXPECTED_TARGET}"`);
  if (manifest.board !== EXPECTED_BOARD) warn(`board "${manifest.board}" != "${EXPECTED_BOARD}"`);
  if (manifest.channel !== channel)
    warn(`manifest channel "${manifest.channel}" != file "${channel}"`);

  if (firmware.length !== manifest.appSizeBytes) {
    err(`appSizeBytes ${manifest.appSizeBytes} != actual ${firmware.length} bytes`);
  }
  if (firmware.length > OTA_SLOT_SIZE) {
    err(`firmware ${firmware.length} B exceeds OTA slot ${OTA_SLOT_SIZE} B`);
  }
  const actualSha = createHash('sha256').update(firmware).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    err('sha256 is not 64 lowercase hex chars');
  } else if (actualSha !== manifest.sha256) {
    err(`sha256 mismatch: manifest ${manifest.sha256}, actual ${actualSha}`);
  }
  return issues;
}

// Derives the on-disk firmware path for a manifest version: <root>/firmware/<version>/rf-sense.bin
export function firmwarePathFor(root: string, version: string): string {
  return join(root, 'firmware', version, 'rf-sense.bin');
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Scans the OTA root for stable/development manifests and validates each present one.
export async function validateOtaRoot(root: string): Promise<ManifestResult[]> {
  const channels: Channel[] = ['stable', 'development'];
  const results: ManifestResult[] = [];
  for (const channel of channels) {
    const manifestPath = join(root, 'manifest', `${channel}.json`);
    if (!(await exists(manifestPath))) {
      results.push({ channel, present: false, issues: [] });
      continue;
    }
    const issues: ValidationIssue[] = [];
    let manifest: Manifest | undefined;
    let firmwarePath: string | undefined;
    try {
      const raw = await loadJson(manifestPath);
      if (!isManifest(raw)) {
        issues.push({ channel, level: 'error', message: 'manifest JSON missing required fields' });
      } else {
        manifest = raw;
        firmwarePath = firmwarePathFor(root, raw.version);
        if (!(await exists(firmwarePath))) {
          issues.push({ channel, level: 'error', message: `firmware not found: ${firmwarePath}` });
        } else {
          const fw = await readFile(firmwarePath);
          issues.push(...checkManifestAgainstFirmware(channel, raw, fw));
        }
      }
    } catch (e) {
      issues.push({
        channel,
        level: 'error',
        message: `failed to read manifest: ${(e as Error).message}`,
      });
    }
    results.push({
      channel,
      present: true,
      ...(manifest ? { manifest } : {}),
      ...(firmwarePath ? { firmwarePath } : {}),
      issues,
    });
  }
  return results;
}

export function hasErrors(results: ManifestResult[]): boolean {
  return results.some((r) => r.issues.some((i) => i.level === 'error'));
}
