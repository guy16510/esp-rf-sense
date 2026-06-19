import dgram from 'node:dgram';

const host = process.env.RF_UDP_HOST || '127.0.0.1';
const port = Number(process.env.RF_UDP_PORT || 5566);
const socket = dgram.createSocket('udp4');
const sequences = new Map([101, 102, 103, 104].map((id) => [id, 0]));
const started = Date.now();

const timer = setInterval(() => {
  const elapsed = Date.now() - started;
  for (const deviceId of sequences.keys()) {
    const sequence = sequences.get(deviceId) || 0;
    const baseline = elapsed < 1800;
    const amplitude = baseline ? 10 + (deviceId % 3) : sequence % 2 === 0 ? 6 : 34 + (deviceId % 5);
    const packet = encodeDatagram({
      deviceId,
      bootId: 5000 + deviceId,
      packetSequence: sequence,
      frameSequence: sequence,
      timestampUs: sequence * 50_000,
      amplitude,
    });
    socket.send(packet, port, host);
    sequences.set(deviceId, sequence + 1);
  }
}, 50);

timer.unref();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => undefined, 1000);

function stop() {
  clearInterval(timer);
  socket.close();
  process.exit(0);
}

function encodeDatagram(input) {
  const csi = Buffer.from([
    input.amplitude,
    0,
    input.amplitude + 1,
    0,
    input.amplitude + 2,
    0,
    input.amplitude + 3,
    0,
  ]);
  const payloadLength = 28 + csi.length;
  const body = Buffer.alloc(32 + payloadLength);
  body.set([0x52, 0x46, 0x43, 0x53], 0);
  body[4] = 1;
  body[5] = 0;
  body.writeUInt32LE(input.deviceId, 8);
  body.writeUInt32LE(input.bootId, 12);
  body.writeUInt32LE(input.packetSequence, 16);
  body.writeUInt16LE(1, 24);
  body.writeUInt16LE(payloadLength, 26);

  const offset = 32;
  body.writeUInt32LE(input.frameSequence, offset);
  body.writeBigUInt64LE(BigInt(input.timestampUs), offset + 4);
  body.writeInt8(-45, offset + 16);
  body[offset + 23] = 0;
  body.writeUInt16LE(csi.length, offset + 26);
  csi.copy(body, offset + 28);

  const output = Buffer.alloc(body.length + 4);
  body.copy(output);
  output.writeUInt32LE(crc32(body), body.length);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
