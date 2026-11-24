// Unit tests for the download manager, with a fake cache and fake network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DownloadManager, sha256Hex } from '../src/offline/download-manager.js';
import { hashFromUrl, savedHashes } from '../src/offline/caches.js';

const BASE = 'https://app.example/datasheets/';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Three fake PDFs, keyed by their real SHA-256. */
const FILES = Object.fromEntries(
  ['%PDF one', '%PDF two', '%PDF three'].map((text) => [sha(text), text]),
);
const SHAS = Object.keys(FILES);
const items = (shas = SHAS) => shas.map((s) => ({ sha: s, bytes: FILES[s]?.length ?? 10, label: `P-${s.slice(0, 4)}` }));

class FakeCache {
  constructor() {
    this.store = new Map();
    this.putCount = 0;
    this.failPutWith = null;
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
  async put(url, response) {
    if (this.failPutWith) throw this.failPutWith;
    this.putCount++;
    this.store.set(url, await response.text());
  }
}

/**
 * Network fake. `plan[sha]` is a list of what each successive request gets:
 * 'ok', 'corrupt', 'network', 500, 404. Missing = always 'ok'.
 */
function fakeNetwork(plan = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fetch = async (url, { signal }) => {
    const s = hashFromUrl(url);
    calls.push(s);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const outcome = (plan[s] ?? []).shift() ?? 'ok';
      if (outcome === 'network') throw new TypeError('Failed to fetch');
      if (typeof outcome === 'number') return new Response('err', { status: outcome });
      const body = outcome === 'corrupt' ? 'garbage' : FILES[s];
      if (body === undefined) return new Response('nope', { status: 404 });
      return new Response(body, { status: 200 });
    } finally {
      active--;
    }
  };
  return { fetch, calls, maxActive: () => maxActive };
}

function makeManager({ cache = new FakeCache(), network = fakeNetwork() } = {}) {
  const events = { firstSave: 0, syncComplete: 0, sleeps: [] };
  const manager = new DownloadManager({
    fetch: network.fetch,
    openCache: async () => cache,
    urlFor: (s) => `${BASE}${s}.pdf`,
    sha256: sha256Hex,
    sleep: async (ms) => events.sleeps.push(ms), // no real waiting in tests
    onFirstSave: () => events.firstSave++,
    onSyncComplete: () => events.syncComplete++,
  });
  return { manager, cache, network, events };
}

test('downloads every file, verified, and reports progress', async () => {
  const { manager, cache, events } = makeManager();
  const progress = [];
  manager.addEventListener('progress', (e) => progress.push(e.detail.done));
  const result = await manager.download(items());

  assert.equal(result.done, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, []);
  assert.equal(cache.store.size, 3);
  for (const [url, body] of cache.store) assert.equal(sha(body), hashFromUrl(url));
  assert.equal(progress.at(-1), 3);
  assert.equal(events.firstSave, 1);
  assert.equal(events.syncComplete, 1);
});

test('never runs more than 3 downloads at once', async () => {
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [sha(`f${i}`), `f${i}`]));
  Object.assign(FILES, many);
  const network = fakeNetwork();
  const { manager } = makeManager({ network });
  await manager.download(items(Object.keys(many)));
  assert.equal(network.maxActive(), 3);
  for (const key of Object.keys(many)) delete FILES[key];
});

test('resuming skips files already in the cache', async () => {
  const cache = new FakeCache();
  cache.store.set(`${BASE}${SHAS[0]}.pdf`, FILES[SHAS[0]]);
  const network = fakeNetwork();
  const { manager } = makeManager({ cache, network });
  const result = await manager.download(items());
  assert.equal(result.total, 2);
  assert.deepEqual(network.calls.sort(), [SHAS[1], SHAS[2]].sort());
});

test('the same datasheet listed twice downloads once', async () => {
  const network = fakeNetwork();
  const { manager } = makeManager({ network });
  await manager.download([...items([SHAS[0]]), ...items([SHAS[0]])]);
  assert.equal(network.calls.length, 1);
});

test('a damaged download is retried and never saved', async () => {
  const network = fakeNetwork({ [SHAS[0]]: ['corrupt', 'ok'] });
  const { manager, cache, events } = makeManager({ network });
  const result = await manager.download(items([SHAS[0]]));
  assert.equal(result.done, 1);
  assert.equal(cache.putCount, 1);
  assert.deepEqual(events.sleeps, [1000]);
});

test('gives up after 3 tries with backoff, and keeps going with other files', async () => {
  const network = fakeNetwork({ [SHAS[0]]: ['network', 500, 'corrupt'] });
  const { manager, cache, events } = makeManager({ network });
  const result = await manager.download(items());
  assert.equal(result.done, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].sha, SHAS[0]);
  assert.match(result.failed[0].error, /damaged/);
  assert.deepEqual(events.sleeps, [1000, 4000]);
  assert.equal(cache.store.size, 2);
  assert.equal(events.syncComplete, 0, 'not "synced" while a file is missing');
});

test('a 404 is not retried', async () => {
  const missing = sha('not on server');
  const network = fakeNetwork();
  const { manager, events } = makeManager({ network });
  const result = await manager.download([{ sha: missing, bytes: 5, label: 'GONE-1' }]);
  assert.equal(network.calls.length, 1);
  assert.equal(events.sleeps.length, 0);
  assert.match(result.failed[0].error, /Not found/);
});

test('retryFailed downloads only the files that failed', async () => {
  const network = fakeNetwork({ [SHAS[1]]: ['network', 'network', 'network'] });
  const { manager, cache } = makeManager({ network });
  await manager.download(items());
  assert.equal(cache.store.size, 2);
  const again = await manager.retryFailed();
  assert.equal(again.total, 1);
  assert.equal(again.failed.length, 0);
  assert.equal(cache.store.size, 3);
});

test('storage full stops the run with a clear error and keeps saved files', async () => {
  const cache = new FakeCache();
  const { manager } = makeManager({ cache });
  let saves = 0;
  manager.addEventListener('saved', () => {
    if (++saves === 1) cache.failPutWith = new DOMException('full', 'QuotaExceededError');
  });
  const finished = new Promise((resolve) =>
    manager.addEventListener('finished', (e) => resolve(e.detail), { once: true }),
  );
  await manager.download(items());
  const detail = await finished;
  assert.equal(detail.quotaExceeded, true);
  assert.ok(detail.failed.some((f) => f.error === 'Device storage is full'));
  assert.ok(cache.store.size >= 1, 'files saved before the error are kept');
});

test('cancel stops the run without marking files as failed', async () => {
  const { manager, cache } = makeManager();
  const run = manager.download(items());
  manager.cancel();
  const result = await run;
  assert.deepEqual(result.failed, []);
  assert.ok(cache.store.size < 3);
  assert.equal(manager.running, false);
});

test('adding files during a run joins the same run', async () => {
  const network = fakeNetwork();
  const { manager } = makeManager({ network });
  const first = manager.download(items([SHAS[0]]));
  const second = manager.download(items([SHAS[1], SHAS[2]]));
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.total, 3);
  assert.equal(result.done, 3);
});

test('savedHashes reads hashes back out of cache keys', async () => {
  const cache = new FakeCache();
  cache.store.set(`${BASE}${SHAS[0]}.pdf`, 'x');
  cache.store.set('https://app.example/other.txt', 'y');
  assert.deepEqual([...(await savedHashes(cache))], [SHAS[0]]);
});

test('the service worker uses the same cache names as the app', async () => {
  const { readFileSync } = await import('node:fs');
  const { DATASHEET_CACHE, SHELL_CACHE_PREFIX } = await import('../src/offline/caches.js');
  const sw = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8');
  assert.match(sw, new RegExp(`const DATASHEET_CACHE = '${DATASHEET_CACHE}';`));
  assert.match(sw, new RegExp(`const SHELL_CACHE_PREFIX = '${SHELL_CACHE_PREFIX}';`));
});

test('files are saved under keyFor, and saved events say which parts they belong to', async () => {
  const cache = new FakeCache();
  const manager = new DownloadManager({
    fetch: fakeNetwork().fetch,
    openCache: async () => cache,
    urlFor: (s) => `https://datasheets.example/datasheets/${s}.pdf`,
    keyFor: (s) => `https://app.example/datasheets/${s}.pdf`,
    sha256: sha256Hex,
    sleep: async () => {},
  });
  const saved = [];
  manager.addEventListener('saved', (e) => saved.push(e.detail.item.partIds));
  await manager.download([{ sha: SHAS[0], bytes: 8, label: 'A', partIds: ['p1', 'p2'] }]);
  assert.deepEqual([...cache.store.keys()], [`https://app.example/datasheets/${SHAS[0]}.pdf`]);
  assert.deepEqual(saved, [['p1', 'p2']]);
});
