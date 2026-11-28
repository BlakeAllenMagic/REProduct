// Unit tests for the browser-free parts of the app. Run: npm test
// Uses Node's built-in test runner, so no test framework dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseHash, hrefFor } from '../src/router.js';
import { specHeader, specValue, formatBytes, MISSING } from '../src/format.js';
import { indexLinecard } from '../src/data.js';
import { clampZoom, scrollToKeep, fitWidth } from '../src/ui/diagram-zoom.js';

const linecard = JSON.parse(readFileSync(new URL('./fixtures/linecard.json', import.meta.url)));

test('routes: one manufacturer\'s parts of a category', () => {
  assert.deepEqual(parseHash('#/category/switch/Teledyne%20e2v'), { name: 'category', id: 'switch', manufacturer: 'Teledyne e2v' });
  assert.equal(hrefFor('category', 'switch', 'Teledyne e2v'), '#/category/switch/Teledyne%20e2v');
  assert.equal(hrefFor('category', 'switch'), '#/category/switch');
});

test('parseHash: known routes', () => {
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#/category/lna'), { name: 'category', id: 'lna' });
  assert.deepEqual(parseHash('#/part/acme-alm1234'), { name: 'part', id: 'acme-alm1234' });
  assert.deepEqual(parseHash('#/settings'), { name: 'settings' });
  assert.equal(hrefFor('settings'), '#/settings');
  assert.deepEqual(parseHash('#/transmitter'), { name: 'home', diagram: 'transmitter' });
  assert.deepEqual(parseHash('#/receiver'), { name: 'home', diagram: 'receiver' });
  assert.equal(hrefFor('home', 'transmitter'), '#/transmitter');
  assert.equal(hrefFor('home'), '#/');
});

test('parseHash: junk goes home', () => {
  assert.deepEqual(parseHash('#/category'), { name: 'home' });
  assert.deepEqual(parseHash('#/transmitter/x'), { name: 'home' });
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

test('indexLinecard: groups for the product-type grid, empty when the data has none', () => {
  assert.deepEqual(indexLinecard(linecard).groups, []);
  assert.deepEqual(indexLinecard({ ...linecard, groups: ['RF', 'Power'] }).groups, ['RF', 'Power']);
});

test('indexLinecard rejects malformed data', () => {
  assert.throws(() => indexLinecard({}), /missing/);
});

test('parts with no link get a search of their maker\'s site', async () => {
  const { manufacturerSites, searchLinkFor } = await import('../src/data.js');
  const sites = manufacturerSites([
    { manufacturer: 'Marki Microwave', productUrl: null },
    { manufacturer: 'Marki Microwave', productUrl: 'https://www.markimicrowave.com/products/x/' },
  ]);
  assert.equal(sites.get('Marki Microwave'), 'markimicrowave.com');
  const link = new URL(searchLinkFor({ manufacturer: 'Marki Microwave', mpn: 'A-3567UC' }, sites));
  assert.equal(link.searchParams.get('q'), 'site:markimicrowave.com A-3567UC');
  const unknown = new URL(searchLinkFor({ manufacturer: 'Other Co', mpn: 'X-1' }, sites));
  assert.equal(unknown.searchParams.get('q'), 'Other Co X-1 datasheet');
});

test('specRows lists the maker, description and every non-empty spec with its unit', async () => {
  const { specRows } = await import('../src/ui/spec-list.js');
  const category = {
    specs: [
      { key: 'nf_db', label: 'NF', unit: 'dB', type: 'number' },
      { key: 'tune_min_ghz', label: 'Tune Min', unit: 'GHz', type: 'number' },
      { key: 'eccn', label: 'ECCN', type: 'text' },
    ],
  };
  const part = { manufacturer: 'Acme RF', description: 'An LNA', specs: { nf_db: 0.6, tune_min_ghz: null, eccn: 'EAR99' } };
  assert.deepEqual(specRows(part, category), [
    ['Manufacturer', 'Acme RF'],
    ['Description', 'An LNA'],
    ['NF (dB)', '0.6'],
    ['ECCN', 'EAR99'],
  ]);
});

test('diagram zoom: the point under the fingers stays put; zoom stays within 1× to 3×', () => {
  // Card padding 8 px, not scrolled, fingers 408 px in: drawing x = 400 units.
  // At 2× that point is 808 px in, so scroll 400 px to keep it under the fingers.
  assert.equal(scrollToKeep(0, 8, 408, 1, 2), 400);
  assert.equal(scrollToKeep(400, 8, 408, 2, 2), 400); // no change, no move
  assert.equal(scrollToKeep(400, 8, 408, 2, 1), 0); // back to 1×
  assert.equal(clampZoom(0.5), 1);
  assert.equal(clampZoom(5), 3);
  assert.equal(clampZoom(1.5), 1.5);
});

test('diagram fit: fills the width unless that would be taller than the space below it', () => {
  // Wide window: the receiver (1000 x 404) fills the 1000 px card.
  assert.equal(fitWidth({ viewBoxWidth: 1000, viewBoxHeight: 404, innerWidth: 1000, availableHeight: 900 }), 1000);
  // Short window: the transmitter (1000 x 532) gets 400 px of height -> 751 px wide.
  assert.equal(fitWidth({ viewBoxWidth: 1000, viewBoxHeight: 532, innerWidth: 1000, availableHeight: 400 }), 751);
  // Power (840 units) keeps the same scale as the others: 840 px in a 1000 px card.
  assert.equal(fitWidth({ viewBoxWidth: 840, viewBoxHeight: 404, innerWidth: 1000, availableHeight: 900 }), 840);
  // Never squeezed below 180 px tall, however short the window.
  assert.equal(fitWidth({ viewBoxWidth: 1000, viewBoxHeight: 404, innerWidth: 1000, availableHeight: 50 }), 445);
});
