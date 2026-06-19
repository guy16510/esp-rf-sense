const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

const tools = [
  {
    name: "serial_list_devices",
    description: "List allowlisted USB serial devices connected to the host. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["devices"],
      properties: {
        devices: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "allowed"],
            properties: {
              path: { type: "string" },
              allowed: { type: "boolean" },
            },
          },
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "baudRate", "openedAt", "nextCursor", "bufferBaseCursor", "error"],
      properties: {
        path: { type: "string" },
        baudRate: { type: "integer" },
        openedAt: { type: "string" },
        nextCursor: { type: "integer" },
        bufferBaseCursor: { type: "integer" },
        error: nullableString,
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "data", "cursor", "nextCursor", "truncated", "endCursor", "error"],
      properties: {
        path: { type: "string" },
        data: { type: "string" },
        cursor: { type: "integer" },
        nextCursor: { type: "integer" },
        truncated: { type: "boolean" },
        endCursor: { type: "integer" },
        error: nullableString,
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export function createMcpHandler(serialManager) {
  return async function handleMcp(message) {
    const hasId = Object.prototype.hasOwnProperty.call(message ?? {}, "id");

    try {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return hasId ? error(message?.id ?? null, -32600, "invalid JSON-RPC request") : null;
      }

      if (message.method === "initialize") {
        const requestedVersion = message.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0];

        return result(message.id, {
          protocolVersion,
          serverInfo: { name: "esp-rf-sense-usb-mcp", version: "0.2.0" },
          capabilities: { tools: { listChanged: false } },
          instructions: "Read-only access to explicitly allowlisted USB serial logs on the connected host.",
        });
      }

      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
        return null;
      }

      if (message.method === "ping") {
        return hasId ? result(message.id, {}) : null;
      }

      if (message.method === "tools/list") {
        return result(message.id, { tools });
      }

      if (message.method === "tools/call") {
        const { name, arguments: args = {} } = message.params ?? {};
        const payload = await callTool(serialManager, name, args);
        return result(message.id, {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          isError: false,
        });
      }

      return hasId ? error(message.id, -32601, `method not found: ${message.method}`) : null;
    } catch (err) {
      return hasId ? error(message.id, -32000, err instanceof Error ? err.message : String(err)) : null;
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
