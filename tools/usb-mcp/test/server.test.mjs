import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";

async function withServer(run) {
  const serialManager = {
    async listDevices() {
      return [{ path: "/dev/cu.usbmodem1101", allowed: true }];
    },
    async openDevice(args) {
      return {
        path: args.path,
        baudRate: args.baudRate ?? 115200,
        openedAt: "2026-06-19T00:00:00.000Z",
        nextCursor: 0,
        bufferBaseCursor: 0,
        error: null,
      };
    },
    async readDevice(args) {
      return {
        path: args.path,
        data: "ready\n",
        cursor: args.cursor ?? 0,
        nextCursor: 6,
        truncated: false,
        endCursor: 6,
        error: null,
      };
    },
  };

  const { server, listen } = createServer({ serialManager, host: "127.0.0.1", port: 0 });
  const address = await listen();
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function post(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
}

test("HTTP transport completes the MCP lifecycle and tool call", async () => {
  await withServer(async (url) => {
    const initializeResponse = await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(initializeResponse.status, 200);
    const initialize = await initializeResponse.json();
    assert.equal(initialize.result.protocolVersion, "2025-06-18");

    const notificationResponse = await post(url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notificationResponse.status, 202);
    assert.equal(await notificationResponse.text(), "");

    const toolsResponse = await post(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.equal(toolsResponse.status, 200);
    const tools = await toolsResponse.json();
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name),
      ["serial_list_devices", "serial_open", "serial_read"],
    );

    const callResponse = await post(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "serial_list_devices", arguments: {} },
    });
    assert.equal(callResponse.status, 200);
    const call = await callResponse.json();
    assert.deepEqual(call.result.structuredContent, {
      devices: [{ path: "/dev/cu.usbmodem1101", allowed: true }],
    });
  });
});

test("GET is rejected when SSE is not implemented", async () => {
  await withServer(async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });
});
