// Unit tests for part search (src/search.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalize, searchParts } from '../src/search.js';

const { parts } = JSON.parse(readFileSync(new URL('../public/linecard.json', import.meta.url)));
const mpns = (query) => searchParts(parts, query).map((p) => p.mpn);

test('normalize ignores capitals and separators', () => {
  assert.equal(normalize('ALM-1234'), 'alm1234');
  assert.equal(normalize(' alm 12.34/x_y '), 'alm1234xy');
});

test('finds a part number however it is typed', () => {
  for (const query of ['ALM-1234', 'alm1234', 'alm 1234', 'Alm-12']) {
    assert.equal(mpns(query)[0], 'ALM-1234', query);
  }
});

test('a part number that starts with the query comes first', () => {
  // "0750" is inside AMX-0750's number; "amx" starts it.
  assert.deepEqual(mpns('amx'), ['AMX-0750']);
  assert.deepEqual(mpns('0750'), ['AMX-0750']);
});

test('also matches manufacturer and description, after part numbers', () => {
  assert.deepEqual(mpns('gnss'), ['NLA-0310']);
  assert.ok(mpns('northwind').every((m) => ['NLA-0310', 'NMX-2600', 'NFL-6000'].includes(m)));
  // "afb" is a part number match; it must beat any description match
  assert.equal(mpns('afb')[0], 'AFB-2450');
});

test('ranking: starts-with, then contains, then other fields', () => {
  const fake = [
    { mpn: 'XYZ-100', manufacturer: 'Zed', description: 'has 100 inside' },
    { mpn: '100-ABC', manufacturer: 'Zed', description: '' },
    { mpn: 'Q1', manufacturer: 'Zed', description: 'model 100' },
  ];
  assert.deepEqual(searchParts(fake, '100').map((p) => p.mpn), ['100-ABC', 'XYZ-100', 'Q1']);
});

test('empty or no-match queries return nothing', () => {
  assert.deepEqual(mpns(''), []);
  assert.deepEqual(mpns('  - '), []);
  assert.deepEqual(mpns('zzzz'), []);
});

test('results are capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ mpn: `P-${i}`, manufacturer: 'M', description: '' }));
  assert.equal(searchParts(many, 'p').length, 50);
});
