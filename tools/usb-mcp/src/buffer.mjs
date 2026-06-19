export class CursorBuffer {
  constructor({ maxBytes = 256 * 1024 } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
    this.maxBytes = maxBytes;
    this.baseOffset = 0;
    this.chunks = [];
    this.waiters = new Set();
  }

  get endOffset() {
    return this.baseOffset + this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  append(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.trim();
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  read({ cursor = this.baseOffset, maxBytes = 64 * 1024 } = {}) {
    const requested = Number.isFinite(cursor) ? Math.trunc(cursor) : this.baseOffset;
    const start = Math.max(requested, this.baseOffset);
    const cappedMaxBytes = Math.max(1, Math.min(Math.trunc(maxBytes), this.maxBytes));
    let offset = this.baseOffset;
    const parts = [];
    let bytes = 0;

    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd <= start) {
        offset = chunkEnd;
        continue;
      }
      const sliceStart = Math.max(0, start - offset);
      const available = chunk.length - sliceStart;
      const take = Math.min(available, cappedMaxBytes - bytes);
      if (take <= 0) {
        break;
      }
      parts.push(chunk.subarray(sliceStart, sliceStart + take));
      bytes += take;
      offset = chunkEnd;
      if (bytes >= cappedMaxBytes) {
        break;
      }
    }

    return {
      data: Buffer.concat(parts).toString("utf8"),
      cursor: start,
      nextCursor: start + bytes,
      truncated: requested < this.baseOffset,
      endCursor: this.endOffset,
    };
  }

  async readWhenAvailable({ cursor = this.endOffset, maxBytes, timeoutMs = 30_000 } = {}) {
    const immediate = this.read({ cursor, maxBytes });
    if (immediate.nextCursor > immediate.cursor || timeoutMs <= 0) {
      return immediate;
    }
    await new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
    return this.read({ cursor, maxBytes });
  }

  trim() {
    let total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    while (total > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = total - this.maxBytes;
      if (first.length <= excess) {
        this.chunks.shift();
        this.baseOffset += first.length;
        total -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.baseOffset += excess;
        total -= excess;
      }
    }
  }
}
