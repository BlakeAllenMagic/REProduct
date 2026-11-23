// Unit tests for the browser-free parts of the app. Run: npm test
// Uses Node's built-in test runner, so no test framework dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseHash, hrefFor } from '../src/router.js';
import { specHeader, specValue, formatBytes, MISSING } from '../src/format.js';
import { indexLinecard } from '../src/data.js';

const linecard = JSON.parse(readFileSync(new URL('../public/linecard.json', import.meta.url)));

test('parseHash: known routes', () => {
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#/category/lna'), { name: 'category', id: 'lna' });
  assert.deepEqual(parseHash('#/part/acme-alm1234'), { name: 'part', id: 'acme-alm1234' });
  assert.deepEqual(parseHash('#/settings'), { name: 'settings' });
  assert.equal(hrefFor('settings'), '#/settings');
});

test('parseHash: junk goes home', () => {
  assert.deepEqual(parseHash('#/category'), { name: 'home' });
  assert.deepEqual(parseHash('#/nope/x'), { name: 'home' });
  assert.deepEqual(parseHash('#/part/a/b'), { name: 'home' });
});

test('hrefFor round-trips through parseHash', () => {
  const href = hrefFor('part', 'odd id/with slash');
  assert.deepEqual(parseHash(href), { name: 'part', id: 'odd id/with slash' });
  assert.equal(hrefFor('home'), '#/');
});

test('specHeader puts the unit in the header', () => {
  assert.equal(specHeader({ label: 'NF', unit: 'dB' }), 'NF (dB)');
  assert.equal(specHeader({ label: 'Package' }), 'Package');
});

test('specValue formats numbers and missing values', () => {
  const num = { type: 'number' };
  assert.equal(specValue(num, 0.6), '0.6');
  assert.equal(specValue(num, 18), '18');
  assert.equal(specValue(num, 1.565), '1.565');
  assert.equal(specValue(num, 0.1 + 0.2), '0.3');
  assert.equal(specValue(num, undefined), MISSING);
  assert.equal(specValue({ type: 'text' }, 'SAW'), 'SAW');
});

test('formatBytes', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(2483112), '2.4 MB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
});

test('indexLinecard maps blocks to categories from categories.yaml', () => {
  const ctx = indexLinecard(linecard);
  assert.equal(ctx.categoryForBlock.get('lna').id, 'lna');
  assert.equal(ctx.categoryForBlock.get('rf_filter').id, 'filter');
  assert.equal(ctx.categoryForBlock.get('if_filter').id, 'filter');
  assert.equal(ctx.categoryForBlock.get('adc'), undefined);
  assert.equal(ctx.partsByCategory.get('lna').length, 4);
  assert.equal(ctx.parts.get('acme-alm1234').mpn, 'ALM-1234');
});

test('indexLinecard rejects malformed data', () => {
  assert.throws(() => indexLinecard({}), /missing/);
});
