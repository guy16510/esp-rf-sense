import assert from "node:assert/strict";
import test from "node:test";
import { CursorBuffer } from "../src/buffer.mjs";

test("serial buffering trims old data and reports truncation", () => {
  const buffer = new CursorBuffer({ maxBytes: 5 });
  buffer.append("abc");
  buffer.append("def");
  assert.deepEqual(buffer.read({ cursor: 0 }), {
    data: "bcdef",
    cursor: 1,
    nextCursor: 6,
    truncated: true,
    endCursor: 6,
  });
});

test("cursor reads return only unread bytes", () => {
  const buffer = new CursorBuffer();
  buffer.append("boot\n");
  const first = buffer.read({ cursor: 0 });
  buffer.append("ready\n");
  assert.equal(buffer.read({ cursor: first.nextCursor }).data, "ready\n");
});

test("long poll waits for appended data", async () => {
  const buffer = new CursorBuffer();
  const pending = buffer.readWhenAvailable({ cursor: 0, timeoutMs: 1000 });
  setTimeout(() => buffer.append("late"), 10);
  assert.equal((await pending).data, "late");
});
