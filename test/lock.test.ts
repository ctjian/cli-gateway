import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { acquireProcessLock } from '../src/runtime/lock.js';

test('acquireProcessLock creates and releases lock', () => {
  const p = `/tmp/cli-gateway-lock-${Date.now()}.json`;
  try {
    const lock = acquireProcessLock(p);
    assert.ok(fs.existsSync(p));

    assert.throws(() => acquireProcessLock(p), /Another instance is running/);

    lock.release();
  } finally {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
});
