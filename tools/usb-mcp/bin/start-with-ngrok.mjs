#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "../src/server.mjs";

const host = process.env.USB_MCP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.USB_MCP_PORT ?? "8787", 10);
const { server, listen } = createServer({ host, port });
await listen();
console.error(`USB serial MCP listening on http://${host}:${port}/mcp`);

const ngrok = spawn("ngrok", ["http", `http://${host}:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
ngrok.on("error", (error) => {
  console.error(`failed to start ngrok: ${error.message}`);
  process.exitCode = 1;
  server.close();
});

const lines = createInterface({ input: ngrok.stdout });
lines.on("line", (line) => {
  process.stdout.write(`${line}\n`);
  const match = line.match(/https:\/\/[^\s]+\.ngrok(?:-free)?\.app/);
  if (match) {
    console.log("\nChatGPT MCP URL");
    console.log(`${match[0]}/mcp`);
  }
});
ngrok.stderr.on("data", (chunk) => process.stderr.write(chunk));

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  ngrok.kill("SIGTERM");
  server.close(() => process.exit(0));
}
