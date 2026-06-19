import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { CursorBuffer } from "./buffer.mjs";
import { listSerialDevices, matchesAllowedDevice, parseAllowedDevices } from "./devices.mjs";

export class SerialManager {
  constructor({
    maxDevices = 4,
    maxBufferBytes = 256 * 1024,
    allowed = parseAllowedDevices(),
    openFn = open,
    streamFactory = createReadStream,
    spawnFn = spawn,
    listDevicesFn = listSerialDevices,
  } = {}) {
    this.maxDevices = maxDevices;
    this.maxBufferBytes = maxBufferBytes;
    this.allowed = allowed;
    this.openFn = openFn;
    this.streamFactory = streamFactory;
    this.spawnFn = spawnFn;
    this.listDevicesFn = listDevicesFn;
    this.devices = new Map();
  }

  async listDevices() {
    return this.listDevicesFn({ allowed: this.allowed });
  }

  async openDevice({ path, baudRate = 115200 }) {
    if (!matchesAllowedDevice(path, this.allowed)) {
      throw new Error(`device is not allowed: ${path}`);
    }
    if (!Number.isInteger(baudRate) || baudRate <= 0) {
      throw new Error("baudRate must be a positive integer");
    }
    if (this.devices.has(path)) {
      return this.snapshot(path);
    }
    if (this.devices.size >= this.maxDevices) {
      throw new Error(`at most ${this.maxDevices} serial devices may be open`);
    }

    await this.configurePort(path, baudRate);
    const handle = await this.openFn(path, "r");
    const stream = this.streamFactory(path, { flags: "r", autoClose: true });
    const buffer = new CursorBuffer({ maxBytes: this.maxBufferBytes });
    const state = { path, baudRate, openedAt: new Date().toISOString(), buffer, stream, handle, error: null };
    stream.on("data", (chunk) => buffer.append(chunk));
    stream.on("error", (error) => {
      state.error = error.message;
      buffer.append(`\n[usb-mcp stream error] ${error.message}\n`);
    });
    stream.on("close", () => {
      state.closedAt = new Date().toISOString();
    });
    this.devices.set(path, state);
    return this.snapshot(path);
  }

  async readDevice({ path, cursor, maxBytes = 64 * 1024, timeoutMs = 30_000 }) {
    const state = this.devices.get(path);
    if (!state) {
      throw new Error(`device is not open: ${path}`);
    }
    const read = await state.buffer.readWhenAvailable({ cursor, maxBytes, timeoutMs });
    return { path, ...read, error: state.error };
  }

  snapshot(path) {
    const state = this.devices.get(path);
    if (!state) {
      throw new Error(`device is not open: ${path}`);
    }
    return {
      path: state.path,
      baudRate: state.baudRate,
      openedAt: state.openedAt,
      nextCursor: state.buffer.endOffset,
      bufferBaseCursor: state.buffer.baseOffset,
      error: state.error,
    };
  }

  async configurePort(path, baudRate) {
    await new Promise((resolve, reject) => {
      const child = this.spawnFn("stty", ["-f", path, String(baudRate), "raw", "-echo"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`stty failed for ${path}: ${stderr.trim() || `exit ${code}`}`));
        }
      });
    });
  }
}
