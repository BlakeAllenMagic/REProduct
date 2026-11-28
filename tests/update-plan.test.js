// Unit tests for the update decisions (src/offline/update-plan.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filesToDelete, hasEverything, isRecentlyUpdated, partsToUpdate } from '../src/offline/update-plan.js';

const part = (id, sha, updated = '2026-01-01') => ({ id, datasheet: sha ? { sha256: sha, updated } : { sha256: null } });
const ids = (list) => list.map((p) => p.id).sort();

// a: changed (old a1 saved, now a2)   b: unchanged   c: never downloaded   d: no datasheet
const parts = [part('a', 'a2'), part('b', 'b1'), part('c', 'c1'), part('d', null)];
const savedParts = { a: 'a1', b: 'b1' };

test('downloads a changed datasheet the device had, not ones it never downloaded', () => {
  assert.deepEqual(ids(partsToUpdate(parts, new Set(['a1', 'b1']), savedParts, false)), ['a']);
});

test('keep-everything mode also downloads datasheets it never had (new parts)', () => {
  assert.deepEqual(ids(partsToUpdate(parts, new Set(['a1', 'b1']), savedParts, true)), ['a', 'c']);
});

test('nothing to do when the current versions are saved', () => {
  assert.deepEqual(partsToUpdate(parts, new Set(['a2', 'b1']), { a: 'a2', b: 'b1' }, false), []);
});

test('the old version is kept while the new one is not saved yet', () => {
  assert.deepEqual(filesToDelete(parts, new Set(['a1', 'b1']), savedParts), []);
});

test('the old version is deleted once the new one is saved', () => {
  assert.deepEqual(filesToDelete(parts, new Set(['a1', 'a2', 'b1']), { a: 'a2', b: 'b1' }), ['a1']);
});

test('files no part uses at all are deleted', () => {
  assert.deepEqual(filesToDelete(parts, new Set(['b1', 'zz']), { b: 'b1' }), ['zz']);
});

test('current versions are never deleted', () => {
  assert.deepEqual(filesToDelete(parts, new Set(['a2', 'b1', 'c1']), {}), []);
});

test('hasEverything ignores parts without a datasheet', () => {
  assert.equal(hasEverything(parts, new Set(['a2', 'b1', 'c1'])), true);
  assert.equal(hasEverything(parts, new Set(['a2', 'b1'])), false);
});

test('Updated badge: a replaced datasheet, within 30 days only; a first-time datasheet never', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const changed = (date) => ({ id: 'x', datasheet: { sha256: 's', updated: date, changed: date } });
  assert.equal(isRecentlyUpdated(changed('2026-11-10'), now), true);
  assert.equal(isRecentlyUpdated(changed('2026-10-20'), now), false);
  assert.equal(isRecentlyUpdated(part('x', 's', '2026-11-10'), now), false); // saved for the first time
  assert.equal(isRecentlyUpdated(part('x', null), now), false);
});
