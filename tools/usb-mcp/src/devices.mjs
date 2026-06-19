import { readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ALLOWED = "/dev/cu.usbmodem*,/dev/cu.usbserial*";

export function parseAllowedDevices(value = process.env.USB_MCP_ALLOWED_DEVICES ?? DEFAULT_ALLOWED) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function matchesAllowedDevice(devicePath, patterns = parseAllowedDevices()) {
  return patterns.some((pattern) => globToRegExp(pattern).test(devicePath));
}

export async function listSerialDevices({
  devDir = "/dev",
  allowed = parseAllowedDevices(),
  readdirFn = readdir,
} = {}) {
  const entries = await readdirFn(devDir);
  return entries
    .map((entry) => path.join(devDir, entry))
    .filter((devicePath) => matchesAllowedDevice(devicePath, allowed))
    .sort()
    .map((devicePath) => ({ path: devicePath, allowed: true }));
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`);
}
