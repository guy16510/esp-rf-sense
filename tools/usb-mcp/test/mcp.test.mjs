import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.mjs";
import { SerialManager } from "../src/serial.mjs";

test("MCP discovery exposes annotated read-only serial tools with output schemas", async () => {
  const handler = createMcpHandler(new SerialManager({ listDevicesFn: async () => [] }));
  const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["serial_list_devices", "serial_open", "serial_read"]);
  assert.equal(names.some((name) => /write|flash|shell|exec|command/i.test(name)), false);
  for (const tool of response.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.outputSchema.type, "object");
  }
});

test("initialize negotiates protocol and initialized notification has no response", async () => {
  const handler = createMcpHandler(new SerialManager({ listDevicesFn: async () => [] }));
  const initialized = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.version, "0.2.0");

  const notification = await handler({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification, null);
});

test("tool calls return both text and structured content", async () => {
  const handler = createMcpHandler(new SerialManager({
    listDevicesFn: async () => [{ path: "/dev/cu.usbmodem1101", allowed: true }],
  }));
  const response = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "serial_list_devices", arguments: {} },
  });
  assert.deepEqual(response.result.structuredContent, {
    devices: [{ path: "/dev/cu.usbmodem1101", allowed: true }],
  });
  assert.equal(response.result.isError, false);
});

test("serial manager reports open failures without exposing write paths", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("permission denied"));
      child.emit("close", 1);
    });
    return child;
  };
  const manager = new SerialManager({
    allowed: ["/dev/cu.usbmodem*"],
    spawnFn,
    openFn: async () => {
      throw new Error("should not open after stty failure");
    },
  });
  await assert.rejects(
    () => manager.openDevice({ path: "/dev/cu.usbmodem1101", baudRate: 115200 }),
    /permission denied/,
  );
  await assert.rejects(() => manager.openDevice({ path: "/tmp/fake", baudRate: 115200 }), /not allowed/);
});
