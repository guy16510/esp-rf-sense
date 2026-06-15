import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EXPECTED_BOARD, OTA_SLOT_SIZE, type Manifest } from './manifest.js';
import { checkManifestAgainstFirmware } from './validate.js';

function manifestFor(firmware: Buffer, overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    project: 'rf-sense',
    channel: 'stable',
    version: '0.2.0',
    buildId: 'ci-123',
    target: 'esp32s3',
    board: EXPECTED_BOARD,
    flashSizeBytes: 4 * 1024 * 1024,
    appSizeBytes: firmware.length,
    sha256: createHash('sha256').update(firmware).digest('hex'),
    firmwareUrl: 'https://ota.local:8443/firmware/0.2.0/rf-sense.bin',
    releasedAt: '2026-01-01T00:00:00Z',
    minimumCurrentVersion: '',
    mandatory: false,
    releaseNotes: '',
    ...overrides,
  };
}

const errors = (issues: { level: string }[]) => issues.filter((i) => i.level === 'error').length;

describe('checkManifestAgainstFirmware', () => {
  const fw = Buffer.from('a fake firmware image');

  it('passes when everything is consistent', () => {
    expect(errors(checkManifestAgainstFirmware('stable', manifestFor(fw), fw))).toBe(0);
  });

  it('fails on sha256 mismatch', () => {
    const m = manifestFor(fw, { sha256: 'f'.repeat(64) });
    const issues = checkManifestAgainstFirmware('stable', m, fw);
    expect(errors(issues)).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('sha256 mismatch'))).toBe(true);
  });

  it('fails when appSizeBytes disagrees with the actual file', () => {
    const m = manifestFor(fw, { appSizeBytes: fw.length + 1 });
    expect(errors(checkManifestAgainstFirmware('stable', m, fw))).toBeGreaterThan(0);
  });

  it('fails on wrong target', () => {
    const m = manifestFor(fw, { target: 'esp32' });
    expect(errors(checkManifestAgainstFirmware('stable', m, fw))).toBeGreaterThan(0);
  });

  it('fails when the image is larger than one OTA slot', () => {
    const big = Buffer.alloc(OTA_SLOT_SIZE + 1);
    const m = manifestFor(big);
    expect(errors(checkManifestAgainstFirmware('stable', m, big))).toBeGreaterThan(0);
  });

  it('rejects a malformed sha field', () => {
    const m = manifestFor(fw, { sha256: 'not-hex' });
    expect(errors(checkManifestAgainstFirmware('stable', m, fw))).toBeGreaterThan(0);
  });

  it('warns (not errors) on a board mismatch', () => {
    const m = manifestFor(fw, { board: 'some-other-board' });
    const issues = checkManifestAgainstFirmware('stable', m, fw);
    expect(errors(issues)).toBe(0);
    expect(issues.some((i) => i.level === 'warn')).toBe(true);
  });

  it('flags a manifest missing required fields', () => {
    const issues = checkManifestAgainstFirmware('stable', { project: 'rf-sense' }, fw);
    expect(errors(issues)).toBeGreaterThan(0);
  });
});
