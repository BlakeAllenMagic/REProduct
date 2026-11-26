// Unit tests for the parts table filters (src/table-filter.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { activeCount, filtersFor, matches, parseNumber } from '../src/table-filter.js';

const spec = (key, type = 'number', label = key) => ({ key, label, type });
const columns = [
  { key: 'mpn' },
  { key: 'spec:pass_min_ghz', spec: spec('pass_min_ghz', 'number', 'Pass Min') },
  { key: 'spec:pass_max_ghz', spec: spec('pass_max_ghz', 'number', 'Pass Max') },
  { key: 'spec:il_db', spec: spec('il_db') },
  { key: 'spec:family', spec: spec('family', 'text') },
  { key: 'spec:notes', spec: spec('notes', 'text') },
  { key: 'spec:eccn', spec: spec('eccn', 'text') },
  { key: 'description' },
];
const part = (mpn, s) => ({ mpn, specs: s });
const parts = [
  part('BP-1', { pass_min_ghz: 8, pass_max_ghz: 12, il_db: 1.5, family: 'Bandpass', notes: 'Coupling: > 30', eccn: 'EAR99' }),
  part('BP-2', { pass_min_ghz: 9, pass_max_ghz: 20, il_db: 2.5, family: 'Bandpass', eccn: 'EAR99' }),
  part('LP-1', { pass_min_ghz: 0, pass_max_ghz: 6, il_db: 0.8, family: 'Lowpass', eccn: 'EAR99' }),
  part('HP-1', { pass_min_ghz: 10, pass_max_ghz: null, il_db: null, family: 'Highpass', eccn: 'EAR99' }),
];
const filters = filtersFor(columns, parts);
const ids = filters.map((f) => f.id);
const pick = (state) => parts.filter((p) => matches(p, filters, state)).map((p) => p.mpn);

test('filters: frequency range first, then one per column', () => {
  assert.deepEqual(ids, ['range:pass', 'number:il_db', 'choice:family', 'contains:notes']);
  assert.equal(filters[0].label, 'Pass');
  assert.deepEqual(filters[2].options, ['Bandpass', 'Highpass', 'Lowpass']);
  // ECCN has a single value here: nothing to filter, so no filter.
});

test('covers one frequency, or a whole band; no upper edge means "and up"', () => {
  assert.deepEqual(pick({ 'range:pass': { from: '10' } }), ['BP-1', 'BP-2', 'HP-1']);
  assert.deepEqual(pick({ 'range:pass': { from: '10', to: '18' } }), ['BP-2', 'HP-1']);
  assert.deepEqual(pick({ 'range:pass': { from: '18', to: '10' } }), ['BP-2', 'HP-1']); // either order
});

test('at least / at most; parts without a value are left out', () => {
  assert.deepEqual(pick({ 'number:il_db': { max: '2' } }), ['BP-1', 'LP-1']);
  assert.deepEqual(pick({ 'number:il_db': { min: '1', max: '2' } }), ['BP-1']);
  assert.deepEqual(pick({ 'number:il_db': { min: '', max: '' } }), ['BP-1', 'BP-2', 'LP-1', 'HP-1']);
});

test('choices mean "any of"; contains ignores capitals; filters combine', () => {
  assert.deepEqual(pick({ 'choice:family': ['Lowpass', 'Highpass'] }), ['LP-1', 'HP-1']);
  assert.deepEqual(pick({ 'contains:notes': 'COUPLING' }), ['BP-1']);
  const state = { 'range:pass': { from: '10' }, 'choice:family': ['Bandpass'], 'number:il_db': { max: '2' } };
  assert.deepEqual(pick(state), ['BP-1']);
  assert.equal(activeCount(filters, state), 3);
  assert.equal(activeCount(filters, { 'choice:family': [] }), 0);
});

test('typed numbers: decimal comma, blanks and junk', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber(' 2 '), 2);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('ranges work for any unit: "Vin covers 12 V"', () => {
  const cols = [
    { key: 'spec:vin_min_v', spec: { key: 'vin_min_v', label: 'Vin Min', unit: 'V', type: 'number' } },
    { key: 'spec:vin_max_v', spec: { key: 'vin_max_v', label: 'Vin Max', unit: 'V', type: 'number' } },
    { key: 'spec:iout_max_a', spec: { key: 'iout_max_a', label: 'Iout Max', unit: 'A', type: 'number' } },
  ];
  const ps = [
    { mpn: 'BUCK-3V', specs: { vin_min_v: 3, vin_max_v: 3.6, iout_max_a: 20 } },
    { mpn: 'CP-48V', specs: { vin_min_v: 18, vin_max_v: 60, iout_max_a: 6 } },
    { mpn: 'MOD-12V', specs: { vin_min_v: 6, vin_max_v: 14.4, iout_max_a: 4 } },
  ];
  const fs = filtersFor(cols, ps);
  assert.deepEqual(fs.map((f) => f.id), ['range:vin', 'number:iout_max_a']); // Iout Max has no Min: a number filter
  assert.equal(fs[0].label, 'Vin');
  assert.equal(fs[0].unit, 'V');
  const pickV = (state) => ps.filter((p) => matches(p, fs, state)).map((p) => p.mpn);
  assert.deepEqual(pickV({ 'range:vin': { from: '12' } }), ['MOD-12V']);
  assert.deepEqual(pickV({ 'range:vin': { from: '24', to: '48' } }), ['CP-48V']);
});
