// The built app with its service worker: install, download, go offline.
// Covers the phase 2 "done when" and parts of the CLAUDE.md testing checklist.

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BUILT = join(ROOT, 'dist-e2e'); // built by the webServer in playwright.config.js
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

/**
 * A tiny web server for one test, serving the built app and the sample
 * datasheets. Closing it is how these tests "go offline": the server is
 * really gone, like airplane mode. (Playwright's own offline switch blocks
 * requests before WebKit's service worker sees them, so it can't be used.)
 */
async function startServer({ holdBackAfter = Infinity, holdMs = 0, port = 0 } = {}) {
  let pdfRequests = 0;
  // What a "newer" published version serves instead (see publish() below).
  const published = { linecard: null, pdfs: new Map() };
  const pdfLog = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const pdf = /^\/datasheets\/([0-9a-f]{64})\.pdf$/.exec(path);
    if (pdf) pdfLog.push(pdf[1]);
    // Like Cloudflare Pages: /index.html redirects to / (and x.html to x).
    // The app has to cope with this; it once broke page loads (ERR_FAILED).
    if (path.endsWith('.html')) {
      const target = path === '/index.html' ? '/' : path.slice(0, -'.html'.length);
      res.writeHead(308, { Location: target }).end();
      return;
    }
    if (path === '/linecard.json' && published.linecard) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(published.linecard);
      return;
    }
    if (pdf && published.pdfs.has(pdf[1])) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(published.pdfs.get(pdf[1]));
      return;
    }
    const file = pdf
      ? join(ROOT, 'dev-datasheets', `${pdf[1]}.pdf`)
      : join(BUILT, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    };
    // A slow server: datasheets after the first few take holdMs to arrive.
    if (pdf && ++pdfRequests > holdBackAfter) setTimeout(send, holdMs);
    else send();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/`,
    /** Hashes of every PDF requested so far. */
    pdfLog,
    /** Act like the sync job ran: serve a new linecard.json and new PDFs. */
    publish(linecard, pdfs = []) {
      published.linecard = JSON.stringify(linecard);
      for (const body of pdfs) published.pdfs.set(sha256(body), body);
    },
    goOffline: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Any uncaught error on any page of the test fails it.
test.beforeEach(async ({ context }) => {
  const problems = [];
  const watch = (page) => page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  context.pages().forEach(watch);
  context.on('page', watch);
  test.info().problems = problems;
});

test.afterEach(async () => {
  expect(test.info().problems, 'errors in the browser').toEqual([]);
});

/** Load the app and wait until the service worker controls the page. */
async function openApp(page, hash = '#/') {
  await page.goto(hash);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
}

async function downloadAll(page, base = '') {
  await page.goto(`${base}#/settings`);
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.big-stat')).toContainText('5 of 5');
}

test('service worker is active and the shell cache holds the app files', async ({ page }) => {
  await openApp(page);
  const caches = await page.evaluate(async () => {
    const names = await window.caches.keys();
    const shell = names.find((n) => n.startsWith('shell-'));
    const keys = (await (await window.caches.open(shell)).keys()).map((r) => new URL(r.url).pathname);
    return { names, keys };
  });
  expect(caches.names.some((n) => n.startsWith('shell-'))).toBe(true);
  // The page is saved as "/" (not /index.html, which Cloudflare redirects).
  for (const file of ['/', '/linecard.json', '/manifest.webmanifest', '/icons/icon-192.png', '/brand/logo.png']) {
    expect(caches.keys).toContain(file);
  }
  expect(caches.keys.some((k) => /\/assets\/pdf\.worker.*\.mjs$/.test(k))).toBe(true);
  // Datasheets are never put in the shell cache.
  expect(caches.keys.some((k) => k.includes('/datasheets/'))).toBe(false);
});

test('phase 2 done-when: download all, go offline, reopen, full flow works', async ({ page, context }) => {
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  await downloadAll(page, server.url);

  // "Close the app", cut the network, "reopen" it.
  await page.close();
  await server.goOffline();
  const reopened = await context.newPage();
  await reopened.goto(`${server.url}#/`);

  await reopened.locator('[data-block="lna"]').click();
  await expect(reopened.locator('.part-row')).toHaveCount(4);
  await reopened.locator('.part-row', { hasText: 'ALM-1234' }).locator('td').first().click();
  await expect(reopened.locator('.viewer-label').first()).toHaveText('1 / 7');
  await expect(reopened.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);

  await reopened.goto(`${server.url}#/settings`);
  await expect(reopened.locator('.big-stat')).toContainText('5 of 5');
  await expect(reopened.getByText(/App version \w+, saved for offline use/)).toBeVisible();
});

test('offline without downloads: app opens, datasheets say "Not downloaded"', async ({ page, context }) => {
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  await page.close();
  await server.goOffline();
  page = await context.newPage();
  // The browser can't tell it's offline when only the server is gone, so
  // tell the app the way the device would.
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.goto(`${server.url}#/part/acme-amx0750`);
  await expect(page.getByRole('heading', { name: 'Not downloaded' })).toBeVisible();
  await expect(page.getByText('Connect to the internet to download it.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Acme RF website/ })).toBeVisible();
});

test('saved datasheets are complete and match their hashes', async ({ page }) => {
  await openApp(page);
  await downloadAll(page);
  const files = await page.evaluate(async () => {
    const cache = await caches.open('datasheets');
    const out = [];
    for (const request of await cache.keys()) {
      const body = await (await cache.match(request)).arrayBuffer();
      out.push({ url: request.url, bytes: Array.from(new Uint8Array(body)) });
    }
    return out;
  });
  expect(files).toHaveLength(5);
  for (const { url, bytes } of files) {
    const hash = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    expect(url).toContain(`${hash}.pdf`);
  }
});

test('an interrupted Download all resumes without duplicates or damaged files', async ({ page, context }) => {
  // Only the first 2 datasheets arrive quickly; the rest take 6 seconds.
  const slow = await startServer({ holdBackAfter: 2, holdMs: 6000 });
  await openApp(page, `${slow.url}#/settings`);
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.big-stat')).toContainText('2 of 5');

  // Close the app halfway. The 3 slow files never finish.
  await page.close();
  await slow.goOffline();

  // Reopen later with a good connection: same address and port (storage
  // belongs to an origin), normal speed.
  const good = await startServer({ port: slow.port });
  const reopened = await context.newPage();
  await reopened.goto(`${good.url}#/settings`);
  await expect(reopened.locator('.big-stat')).toContainText('2 of 5'); // finished files were kept
  await reopened.getByRole('button', { name: 'Download all' }).click();
  await expect(reopened.locator('.download-progress')).toContainText('3 / 3 files'); // only the missing 3
  await expect(reopened.locator('.big-stat')).toContainText('5 of 5');

  // No duplicates, and every saved file matches its hash.
  const check = await reopened.evaluate(async () => {
    const cache = await caches.open('datasheets');
    const results = [];
    for (const request of await cache.keys()) {
      const body = await (await cache.match(request)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', body);
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      results.push(request.url.endsWith(`${hex}.pdf`));
    }
    return results;
  });
  expect(check).toEqual([true, true, true, true, true]);
  await good.goOffline();
});

test('phase 3 done-when: Send datasheet attaches the PDF while offline', async ({ page, context }) => {
  // Stand-in for the share sheet (the real one is an OS window).
  await context.addInitScript(() => {
    window.__shares = [];
    navigator.canShare = (data) => Array.isArray(data?.files);
    navigator.share = async (data) => {
      const file = data.files[0];
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      window.__shares.push({ name: file.name, type: file.type, sha });
    };
  });
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  await downloadAll(page, server.url);
  await page.close();
  await server.goOffline();

  const reopened = await context.newPage();
  await reopened.goto(`${server.url}#/part/acme-afb2450`);
  await expect(reopened.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);
  await reopened.getByRole('button', { name: 'Send datasheet' }).click();
  await expect.poll(() => reopened.evaluate(() => window.__shares.length)).toBe(1);
  const [share] = await reopened.evaluate(() => window.__shares);
  expect(share.name).toBe('Acme RF AFB-2450 datasheet.pdf');
  expect(share.type).toBe('application/pdf');
  const linecard = JSON.parse(
    (await import('node:fs')).readFileSync(new URL('../fixtures/linecard.json', import.meta.url)),
  );
  expect(share.sha).toBe(linecard.parts.find((p) => p.id === 'acme-afb2450').datasheet.sha256);
});

// ---------------------------------------------------------------------------
// Phase 4: the in-app update flow
// ---------------------------------------------------------------------------

/**
 * A "new version" of AFB-2450's datasheet, published as the sync job would:
 * a new PDF (new hash) and a linecard.json pointing at it, dated today.
 */
function revisedAfb2450() {
  const card = JSON.parse(readFileSync(join(BUILT, 'linecard.json'), 'utf8'));
  const part = card.parts.find((p) => p.id === 'acme-afb2450');
  const oldSha = part.datasheet.sha256;
  const oldPdf = readFileSync(join(ROOT, 'dev-datasheets', `${oldSha}.pdf`));
  const newPdf = Buffer.concat([oldPdf, Buffer.from('\n% sample revision 1\n')]);
  part.datasheet = {
    ...part.datasheet,
    sha256: sha256(newPdf),
    bytes: newPdf.length,
    updated: new Date().toISOString().slice(0, 10),
  };
  card.dataVersion = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return { card, newPdf, oldSha, newSha: part.datasheet.sha256 };
}

async function savedHashes(page) {
  return page.evaluate(async () =>
    (await (await caches.open('datasheets')).keys()).map((r) => /([0-9a-f]{64})\.pdf$/.exec(r.url)[1]).sort(),
  );
}

test('phase 4 done-when: one changed datasheet means exactly one re-download', async ({ page, context }) => {
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  await downloadAll(page, server.url);
  const before = await savedHashes(page);
  expect(before).toHaveLength(5);

  // The sync job publishes a new AFB-2450 datasheet.
  const { card, newPdf, oldSha, newSha } = revisedAfb2450();
  server.publish(card, [newPdf]);
  server.pdfLog.length = 0;

  // The rep opens the app again while online.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${server.url}#/category/filter`);

  // The new version is saved and the old one deleted afterwards.
  await expect.poll(() => savedHashes(reopened), { timeout: 15_000 }).toEqual(
    before.filter((h) => h !== oldSha).concat(newSha).sort(),
  );
  expect(server.pdfLog).toEqual([newSha]); // exactly one PDF downloaded

  // The table (already showing the new line card) marks it as updated.
  const row = reopened.locator('.part-row', { hasText: 'AFB-2450' });
  await expect(row.locator('.badge-updated')).toHaveText('Updated');
  await reopened.goto(`${server.url}#/part/acme-afb2450`);
  await expect(reopened.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);
  await expect(reopened.locator('.viewer-note')).toHaveCount(0);
  await server.goOffline();
});

test('a failed update keeps the previous version viewable', async ({ page, context }) => {
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  await downloadAll(page, server.url);

  // New line card, but its new PDF isn't downloadable (not on the server).
  const { card, oldSha, newSha } = revisedAfb2450();
  server.publish(card, []);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${server.url}#/settings`);
  await expect.poll(() => server.pdfLog.includes(newSha), { timeout: 15_000 }).toBe(true);
  await reopened.waitForTimeout(500);

  expect(await savedHashes(reopened)).toContain(oldSha); // not deleted
  await reopened.goto(`${server.url}#/part/acme-afb2450`);
  await expect(reopened.locator('.viewer-note')).toContainText('previous version');
  await expect(reopened.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);
  await server.goOffline();
});

test('a line card published while the app is open offers a reload', async ({ page }) => {
  const server = await startServer();
  await openApp(page, `${server.url}#/`);
  server.publish(revisedAfb2450().card);
  // Coming back online triggers a check, which fetches the new line card.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.linecard-update')).toContainText('The line card was updated.');
  await server.goOffline();
});
