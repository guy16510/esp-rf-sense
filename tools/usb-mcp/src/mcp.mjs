export function createMcpHandler(serialManager) {
  const tools = [
    {
      name: "serial_list_devices",
      description: "List allowlisted USB serial devices. Read-only.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "serial_open",
      description: "Open an allowlisted USB serial device for read-only log capture.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          baudRate: { type: "integer", minimum: 1, default: 115200 },
        },
      },
    },
    {
      name: "serial_read",
      description: "Read captured serial output using a cursor, with optional long polling.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          cursor: { type: "integer", minimum: 0 },
          maxBytes: { type: "integer", minimum: 1, maximum: 65536 },
          timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        },
      },
    },
  ];

  return async function handleMcp(message) {
    try {
      if (message.method === "initialize") {
        return result(message.id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "esp-rf-sense-usb-mcp", version: "0.1.0" },
          capabilities: { tools: {} },
        });
      }
      if (message.method === "tools/list") {
        return result(message.id, { tools });
      }
      if (message.method === "tools/call") {
        const { name, arguments: args = {} } = message.params ?? {};
        const payload = await callTool(serialManager, name, args);
        return result(message.id, {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        });
      }
      return error(message.id, -32601, `method not found: ${message.method}`);
    } catch (err) {
      return error(message.id, -32000, err instanceof Error ? err.message : String(err));
    }
  };
}

async function callTool(serialManager, name, args) {
  if (name === "serial_list_devices") {
    return { devices: await serialManager.listDevices() };
  }
  if (name === "serial_open") {
    return await serialManager.openDevice(args);
  }
  if (name === "serial_read") {
    return await serialManager.readDevice(args);
  }
  throw new Error(`unknown tool: ${name}`);
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
