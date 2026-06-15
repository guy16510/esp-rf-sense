import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { waitForChild } from './runner.js';

describe('waitForChild', () => {
  it('resolves with the collector exit code', async () => {
    const child = new EventEmitter();
    const result = waitForChild(child as never);
    child.emit('exit', 0);
    await expect(result).resolves.toBe(0);
  });

  it('rejects when the collector cannot be spawned', async () => {
    const child = new EventEmitter();
    const result = waitForChild(child as never);
    child.emit('error', new Error('spawn failed'));
    await expect(result).rejects.toThrow('spawn failed');
  });
});
