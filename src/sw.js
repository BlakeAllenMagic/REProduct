/* Service worker: makes the app work with no internet.
 *
 * The browser runs this file in the background, separate from the page.
 * Every request the app makes (pages, scripts, data, PDFs) passes through
 * the 'fetch' handler below, which decides whether to answer from a saved
 * copy (the Cache API) or from the network.
 *
 * This is a plain script, not an ES module: module service workers are newer
 * and I'm not certain of their support in every Safari 18 version.
 *
 * Built by the Vite plugin in vite.config.js, which replaces the two
 * placeholders below with the shell version and the list of app files.
 * Only the built app registers it (npm run build / npm run preview).
 */

const SHELL_VERSION = '__SHELL_VERSION__';
const PRECACHE = __PRECACHE__; // app files, relative to this file

// Must match src/offline/caches.js (a unit test checks).
const SHELL_CACHE_PREFIX = 'shell-';
const DATASHEET_CACHE = 'datasheets';

const SHELL_CACHE = SHELL_CACHE_PREFIX + SHELL_VERSION;
const LINECARD_TIMEOUT_MS = 3000;
const DATASHEET_PATH = /\/datasheets\/[0-9a-f]{64}\.pdf$/;

// ignoreVary: servers often send "Vary: Origin", which would make the cache
// treat a script loaded with an Origin header as different from the saved
// copy, and miss it when offline. Our files never vary, so ignore it.
const MATCH_OPTIONS = { ignoreSearch: true, ignoreVary: true };

const scoped = (path) => new URL(path, self.registration.scope).href;

// ---------------------------------------------------------------------------
// Install: save every app file into a new shell cache.
//
// If any file fails, the whole install fails and the current version keeps
// running; the browser tries again later. That's fine for ~2 MB of app files.
// It's exactly why datasheets (1.5 GB+) are NOT saved here: one failure among
// thousands of files would fail the install every time.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(PRECACHE.map((path) => saveShellFile(cache, path)));
    })(),
  );
  // No skipWaiting() here: a new version waits until the user taps
  // "Reload" in the update bar, so it can't swap code mid-demo.
});

/**
 * Download one app file and save it.
 *
 * cache: 'reload' skips the browser's normal HTTP cache, so we never save a
 * stale copy. A response that arrived by redirect is saved as a clean copy:
 * browsers refuse a redirected response as the answer to a page load
 * (ERR_FAILED). Cloudflare Pages redirects /index.html to /, which once broke
 * the live app this way; the page itself is now saved as "./" (see
 * tools/vite-sw-plugin.js), and this guards any other file.
 */
async function saveShellFile(cache, path) {
  const url = scoped(path);
  let response = await fetch(new Request(url, { cache: 'reload' }));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (path === './') {
    // The page must belong to this version. If a newer version went live
    // while this one was installing, the site now serves the newer page,
    // which asks for script and style files this version doesn't have; saving
    // it would leave the app unstyled and blank. Failing the install keeps
    // the current version running; the browser tries the update again later.
    const missing = pageFilesNotIn(await response.clone().text(), PRECACHE);
    if (missing.length) throw new Error(`page is from another version (needs ${missing.join(', ')})`);
  }
  if (response.redirected) {
    response = new Response(await response.blob(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  await cache.put(url, response);
}

/**
 * The app files (./assets/...) a page asks for that aren't in `precache`.
 * Kept free of anything service-worker specific so tests/sw-page-check.test.js
 * can run it.
 */
function pageFilesNotIn(html, precache) {
  const have = new Set(precache.map((path) => path.replace(/^\.\//, '')));
  const wanted = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"?#]+)/g)].map((m) => m[1]);
  return [...new Set(wanted)].filter((path) => !have.has(path));
}

// ---------------------------------------------------------------------------
// Activate: this version is now in charge. Delete old shell caches.
// The datasheet cache is never touched here.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE) {
          await caches.delete(name);
        }
      }
      // Take control of pages that are already open (e.g. the very first
      // visit), so they work offline without a reload.
      await self.clients.claim();
    })(),
  );
});

// The page asks for this when the user taps "Reload" in the update bar.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Fetch: decide where each request is answered from.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // let the browser handle it

  const url = new URL(request.url);

  // Datasheets (same origin now; R2 in phase 4): cache first.
  if (DATASHEET_PATH.test(url.pathname)) {
    event.respondWith(datasheetResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) return; // other sites: not ours

  // linecard.json: network first, with a short timeout.
  if (url.pathname.endsWith('/linecard.json')) {
    const network = fetchLinecard();
    // Keep the worker alive until the network answers, even if the page was
    // already given the cached copy: a late answer still updates the cache.
    event.waitUntil(network.catch(() => {}));
    event.respondWith(linecardResponse(network));
    return;
  }

  // Page loads: always the saved app page, saved as "./" (the app has one page).
  if (request.mode === 'navigate') {
    event.respondWith(shellResponse(scoped('./'), request));
    return;
  }

  // Everything else (scripts, styles, icons): cache first.
  event.respondWith(shellResponse(request, request));
});

/** Cache first from the shell cache, network if it's somehow missing. */
async function shellResponse(key, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key, MATCH_OPTIONS);
  return cached ?? fetch(request);
}

/**
 * Cache first from the datasheet cache. If it's not saved, try the network,
 * but never save it here: only the in-app download manager saves datasheets,
 * after checking the file's hash.
 */
async function datasheetResponse(request) {
  const cache = await caches.open(DATASHEET_CACHE);
  // Saved under a fixed key on this device, whichever site it came from
  // (must match datasheetKey() in src/offline/caches.js).
  const sha = /([0-9a-f]{64})\.pdf$/.exec(new URL(request.url).pathname)[1];
  const cached = await cache.match(scoped(`datasheets/${sha}.pdf`), MATCH_OPTIONS);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response('Datasheet not downloaded and no connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/** Fetch linecard.json from the network and, if it worked, save it. */
async function fetchLinecard() {
  const response = await fetch(scoped('linecard.json'), { cache: 'no-store' });
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(scoped('linecard.json'), response.clone());
  }
  return response;
}

/**
 * Network first, but give up waiting after 3 seconds and use the saved
 * copy, so a weak signal never leaves the app hanging on a blank screen.
 */
async function linecardResponse(network) {
  try {
    const response = await withTimeout(network, LINECARD_TIMEOUT_MS);
    if (response.ok) return response;
  } catch {
    // offline, or too slow: fall through to the saved copy
  }
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(scoped('linecard.json'), MATCH_OPTIONS);
  return cached ?? network; // nothing saved yet: keep waiting for the network
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
