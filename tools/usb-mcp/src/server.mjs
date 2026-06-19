import http from "node:http";
import { createMcpHandler } from "./mcp.mjs";
import { SerialManager } from "./serial.mjs";

export function createServer({ serialManager = new SerialManager(), host = "127.0.0.1", port = 8787 } = {}) {
  const handleMcp = createMcpHandler(serialManager);
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, {
        name: "esp-rf-sense-usb-mcp",
        endpoint: "/mcp",
        transport: "streamable-http",
        tools: ["serial_list_devices", "serial_open", "serial_read"],
      });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      const body = await readRequestBody(req);
      const message = JSON.parse(body);
      sendJson(res, 200, await handleMcp(message));
    } catch (err) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      }),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
