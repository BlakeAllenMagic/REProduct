// The service worker only saves a page that belongs to its own version
// (pageFilesNotIn in src/sw.js). Two quick updates in a row once saved a
// newer page with older files, leaving the app blank and unstyled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// sw.js is a plain script (not a module), so take the function's source out of it.
const source = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('function pageFilesNotIn'), source.indexOf('// ----', source.indexOf('function pageFilesNotIn')));
const pageFilesNotIn = new Function(`${body}; return pageFilesNotIn;`)();

const precache = ['./', 'assets/index-AAA.js', 'assets/index-AAA.css', 'icons/icon.svg'];
const page = (js, css) =>
  `<link rel="icon" href="./icons/icon.svg"><script type="module" crossorigin src="./assets/${js}"></script>` +
  `<link rel="stylesheet" crossorigin href="./assets/${css}">`;

test('a page from the same version is accepted', () => {
  assert.deepEqual(pageFilesNotIn(page('index-AAA.js', 'index-AAA.css'), precache), []);
});

test('a page from another version is refused, naming the files it needs', () => {
  assert.deepEqual(pageFilesNotIn(page('index-BBB.js', 'index-BBB.css'), precache), [
    'assets/index-BBB.js',
    'assets/index-BBB.css',
  ]);
});

test('extra things a host adds to the page (analytics, links) do not matter', () => {
  const html = page('index-AAA.js', 'index-AAA.css') + '<script src="https://static.example/beacon.js"></script><a href="#/settings">';
  assert.deepEqual(pageFilesNotIn(html, precache), []);
});
