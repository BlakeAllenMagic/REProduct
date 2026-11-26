// Unit tests for the parts-table text size (src/ui/text-size.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampSize, readTextSize, setTextSize, TEXT_SIZE } from '../src/ui/text-size.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

test('sizes stay between 60% and 120%, rounded to whole percent', () => {
  assert.equal(clampSize(0.5), 0.6);
  assert.equal(clampSize(3), 1.2);
  assert.equal(clampSize(1.123), 1.12);
  assert.equal(clampSize(NaN), 1);
});

test('the size is saved and read back', () => {
  const storage = memoryStorage();
  assert.equal(readTextSize(storage), 1);
  assert.equal(setTextSize(0.7, storage), 0.7);
  assert.equal(readTextSize(storage), 0.7);
  storage.setItem('linecard.tableScale', 'nonsense');
  assert.equal(readTextSize(storage), 1);
});

test('blocked storage falls back to 100% without throwing', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.equal(readTextSize(blocked), 1);
  assert.equal(setTextSize(1.1, blocked), 1.1);
});
