// Unit tests for the parts-table text size (src/ui/text-size.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampSize, readTextSize, setTextSize, TEXT_SIZE } from '../src/ui/text-size.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

test('sizes stay between 80% and 200%, rounded to whole percent', () => {
  assert.equal(clampSize(0.5), TEXT_SIZE.min);
  assert.equal(clampSize(3), TEXT_SIZE.max);
  assert.equal(clampSize(1.234), 1.23);
  assert.equal(clampSize(NaN), 1);
});

test('the size is saved and read back', () => {
  const storage = memoryStorage();
  assert.equal(readTextSize(storage), 1);
  assert.equal(setTextSize(1.5, storage), 1.5);
  assert.equal(readTextSize(storage), 1.5);
  storage.setItem('linecard.tableScale', 'nonsense');
  assert.equal(readTextSize(storage), 1);
});

test('blocked storage falls back to 100% without throwing', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.equal(readTextSize(blocked), 1);
  assert.equal(setTextSize(1.4, blocked), 1.4);
});
