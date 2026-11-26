// Unit tests for the parts table's sorting rules (src/table-sort.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { columnsFor, nextSort, sortParts } from '../src/table-sort.js';

const category = {
  specs: [
    { key: 'nf_db', label: 'NF', unit: 'dB', type: 'number', sort: 'asc' },
    { key: 'gain_db', label: 'Gain', unit: 'dB', type: 'number', sort: 'desc' },
    { key: 'package', label: 'Package', type: 'text' },
  ],
};
const parts = [
  { mpn: 'A', manufacturer: 'M', description: '', specs: { nf_db: 1.8, gain_db: 22, package: '3x3 mm QFN' } },
  { mpn: 'B', manufacturer: 'M', description: '', specs: { nf_db: 0.6, package: '2x2 mm DFN' } },
  { mpn: 'C', manufacturer: 'M', description: '', specs: { gain_db: 17, package: '10x10 mm' } },
  { mpn: 'D', manufacturer: 'M', description: '', specs: { nf_db: 0.75, gain_db: 18 } },
];
const column = (key) => columnsFor(category).find((c) => c.key === key);
const order = (key, dir) => sortParts(parts, column(key), dir).map((p) => p.mpn);

test('a tap cycles: best first, reversed, normal order', () => {
  const nf = column('spec:nf_db');
  const gain = column('spec:gain_db');
  assert.deepEqual(nextSort(null, nf), { key: 'spec:nf_db', dir: 'asc' }); // lower NF is better
  assert.deepEqual(nextSort(null, gain), { key: 'spec:gain_db', dir: 'desc' }); // higher gain is better
  assert.deepEqual(nextSort({ key: 'spec:nf_db', dir: 'asc' }, nf), { key: 'spec:nf_db', dir: 'desc' });
  assert.equal(nextSort({ key: 'spec:nf_db', dir: 'desc' }, nf), null);
  // Tapping another column starts that column at its best-first order.
  assert.deepEqual(nextSort({ key: 'spec:nf_db', dir: 'desc' }, gain), { key: 'spec:gain_db', dir: 'desc' });
});

test('numbers sort numerically, missing values last in both directions', () => {
  assert.deepEqual(order('spec:nf_db', 'asc'), ['B', 'D', 'A', 'C']);
  assert.deepEqual(order('spec:nf_db', 'desc'), ['A', 'D', 'B', 'C']);
  assert.deepEqual(order('spec:gain_db', 'desc'), ['A', 'D', 'C', 'B']);
});

test('text sorts naturally, so 2x2 comes before 10x10', () => {
  assert.deepEqual(order('spec:package', 'asc'), ['B', 'A', 'C', 'D']);
});

test('natural order also handles leading zeros like chip sizes', () => {
  const sizes = ['1008', '0603', '0805'].map((p, i) => ({ mpn: String(i), specs: { package: p } }));
  const sorted = sortParts(sizes, column('spec:package'), 'asc').map((p) => p.specs.package);
  assert.deepEqual(sorted, ['0603', '0805', '1008']);
});

test('sorting does not change the original list', () => {
  const before = parts.map((p) => p.mpn);
  order('spec:nf_db', 'asc');
  assert.deepEqual(parts.map((p) => p.mpn), before);
});

test('columnsFor puts ECCN after every other column, description included', () => {
  const withEccn = {
    specs: [
      { key: 'eccn', label: 'ECCN', type: 'text' },
      { key: 'gain_db', label: 'Gain', unit: 'dB', type: 'number' },
    ],
  };
  const keys = columnsFor(withEccn).map((c) => c.key);
  assert.deepEqual(keys, ['mpn', 'manufacturer', 'spec:gain_db', 'description', 'spec:eccn']);
});

test('columnsFor hides specs that fewer than 10% of the parts fill', () => {
  const cat = {
    specs: [
      { key: 'common', label: 'Common', type: 'number' },
      { key: 'rare', label: 'Rare', type: 'number' },
      { key: 'empty', label: 'Empty', type: 'text' },
    ],
  };
  const parts = Array.from({ length: 20 }, (_, i) => ({ specs: { common: i, rare: i < 2 ? 1 : null, empty: '' } }));
  const keys = (ps) => columnsFor(cat, ps).map((c) => c.key);
  assert.deepEqual(keys(parts), ['mpn', 'manufacturer', 'spec:common', 'spec:rare', 'description']); // 2 of 20 = 10%
  parts[1].specs.rare = null; // 1 of 20
  assert.deepEqual(keys(parts), ['mpn', 'manufacturer', 'spec:common', 'description']);
  assert.deepEqual(keys(parts.slice(0, 3)), ['mpn', 'manufacturer', 'spec:common', 'spec:rare', 'description']); // 1 of 3
  assert.equal(columnsFor(cat).length, 6); // without parts: every column
});
