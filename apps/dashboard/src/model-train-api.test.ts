import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MultiNodeEngine } from './multi-node-engine.js';
import { MultiNodeDashboardServer } from './multi-node-web-server.js';

const temporaryDirectories: string[] = [];
const servers: MultiNodeDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('model training API', () => {
  it('passes target through to the dashboard trainer', async () => {
    const directory = await fixtureRecordings();
    const modelPath = join(directory, 'label-model.json');
    const server = new MultiNodeDashboardServer(new MultiNodeEngine(), {
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20,
      recordingsDir: directory,
      modelPath,
    });
    servers.push(server);
    await server.start();
    const port = server.address()!.port;

    const response = await fetch(`http://127.0.0.1:${port}/api/model/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'label', path: modelPath, window: 4, step: 4 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ loaded: true, target: 'label' });
    expect(JSON.parse(await readFile(modelPath, 'utf8'))).toMatchObject({ target: 'label' });
  });

  it('passes minRecordingsPerClass through to the dashboard trainer', async () => {
    const directory = await fixtureRecordings();
    const modelPath = join(directory, 'undersampled-model.json');
    const server = new MultiNodeDashboardServer(new MultiNodeEngine(), {
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20,
      recordingsDir: directory,
      modelPath,
    });
    servers.push(server);
    await server.start();
    const port = server.address()!.port;

    const response = await fetch(`http://127.0.0.1:${port}/api/model/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'label',
        minRecordingsPerClass: 2,
        path: modelPath,
        window: 4,
        step: 4,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/under-sampled/u),
    });
  });
});

async function fixtureRecordings(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rf-model-api-'));
  temporaryDirectories.push(directory);
  await writeRecording(directory, 'alpha-1', 'alpha', 1, 12);
  await writeRecording(directory, 'beta-1', 'beta', 2, 36);
  return directory;
}

async function writeRecording(
  directory: string,
  name: string,
  label: string,
  deviceId: number,
  amplitude: number,
): Promise<void> {
  await writeFile(
    join(directory, `${name}.meta.json`),
    `${JSON.stringify({ name, label, complete: true }, null, 2)}\n`,
  );
  const chunks: Buffer[] = [];
  for (let index = 0; index < 8; index += 1) {
    const csi = Buffer.alloc(16);
    for (let offset = 0; offset < csi.length; offset += 2) {
      csi[offset] = amplitude;
      csi[offset + 1] = 0;
    }
    const datagram = buildDatagram(deviceId, index, csi);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(datagram.length, 0);
    chunks.push(length, datagram);
  }
  await writeFile(join(directory, `${name}.csi.bin`), Buffer.concat(chunks));
}

function buildDatagram(deviceId: number, sequence: number, csi: Buffer): Buffer {
  const headerBytes = 32;
  const frameBytes = 28;
  const crcBytes = 4;
  const payloadLength = frameBytes + csi.length;
  const buffer = Buffer.alloc(headerBytes + payloadLength + crcBytes);
  buffer.write('RFCS', 0, 'ascii');
  buffer[4] = 1;
  buffer[5] = 0;
  buffer[6] = 0;
  buffer[7] = 0;
  buffer.writeUInt32LE(deviceId >>> 0, 8);
  buffer.writeUInt32LE(1, 12);
  buffer.writeUInt32LE(sequence, 16);
  buffer.writeUInt32LE(sequence, 20);
  buffer.writeUInt16LE(1, 24);
  buffer.writeUInt16LE(payloadLength, 26);
  buffer.writeUInt32LE(0, 28);
  const offset = headerBytes;
  buffer.writeUInt32LE(sequence, offset);
  buffer.writeBigUInt64LE(BigInt(sequence * 1000), offset + 4);
  buffer.writeUInt32LE(0xffffffff, offset + 12);
  buffer.writeInt8(-40, offset + 16);
  buffer.writeInt8(-95, offset + 17);
  buffer[offset + 18] = 6;
  buffer[offset + 19] = 0;
  buffer[offset + 20] = 0;
  buffer[offset + 21] = 2;
  buffer[offset + 22] = 0;
  buffer[offset + 23] = 0;
  buffer.writeUInt16LE(1, offset + 24);
  buffer.writeUInt16LE(csi.length, offset + 26);
  csi.copy(buffer, offset + frameBytes);
  buffer.writeUInt32LE(crc32(buffer.subarray(0, buffer.length - crcBytes)), buffer.length - crcBytes);
  return buffer;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
