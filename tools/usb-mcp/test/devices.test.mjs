import assert from "node:assert/strict";
import test from "node:test";
import { listSerialDevices, matchesAllowedDevice } from "../src/devices.mjs";

test("device discovery returns only allowlisted serial devices", async () => {
  const devices = await listSerialDevices({
    devDir: "/dev",
    allowed: ["/dev/cu.usbmodem*", "/dev/cu.usbserial*"],
    readdirFn: async () => ["cu.usbmodem1101", "cu.Bluetooth-Incoming-Port", "tty.usbserial-A10"],
  });
  assert.deepEqual(devices, [{ path: "/dev/cu.usbmodem1101", allowed: true }]);
});

test("allowlist rejects arbitrary files", () => {
  assert.equal(matchesAllowedDevice("/etc/passwd", ["/dev/cu.usbmodem*"]), false);
  assert.equal(matchesAllowedDevice("/dev/cu.usbserial-123", ["/dev/cu.usbserial*"]), true);
});
