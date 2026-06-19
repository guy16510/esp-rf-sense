#!/usr/bin/env node
import { createServer } from "../src/server.mjs";

const host = process.env.USB_MCP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.USB_MCP_PORT ?? "8787", 10);
const { listen } = createServer({ host, port });
await listen();
console.error(`USB serial MCP listening on http://${host}:${port}/mcp`);
