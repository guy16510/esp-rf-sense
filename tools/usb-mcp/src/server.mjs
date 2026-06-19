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
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      res.end();
      return;
    }

    try {
      const body = await readRequestBody(req);
      const message = JSON.parse(body);
      const response = await handleMcp(message);

      if (response === null) {
        res.writeHead(202, { "cache-control": "no-store" });
        res.end();
        return;
      }

      sendJson(res, 200, response);
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
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
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
  let bytes = 0;
  const maxBytes = 1024 * 1024;

  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new Error("request body exceeds 1 MiB");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}
