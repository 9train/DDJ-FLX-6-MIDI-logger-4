// tests/board.test.js (ESM)
// Uses Node's built-in test runner. Run with: node --test tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRelative7 } from '../src/board.js';

test('inputs 0 and 64 return 0', () => {
  assert.strictEqual(decodeRelative7(0), 0);
  assert.strictEqual(decodeRelative7(64), 0);
});

test('inputs 1..63 produce positive steps', () => {
  for (let v = 1; v <= 63; v++) {
    assert.ok(decodeRelative7(v) > 0, `expected > 0 for v=${v}`);
  }
});

test('inputs 65..127 produce negative steps', () => {
  assert.strictEqual(decodeRelative7(65), -63);
  for (let v = 65; v <= 127; v++) {
    assert.ok(decodeRelative7(v) < 0, `expected < 0 for v=${v}`);
  }
});
