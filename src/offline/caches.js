// Cache names and helpers for the datasheet cache.
//
// Two caches with different lifetimes (CLAUDE.md, Offline strategy):
//   shell-<version>  the app's own files, replaced as a whole on each app update
//   datasheets       PDFs, keyed by their content-addressed URL, only ever added to
//
// src/sw.js repeats these two names (it can't import modules); a unit test
// checks they match.

export const DATASHEET_CACHE = 'datasheets';
export const SHELL_CACHE_PREFIX = 'shell-';

const HASH_IN_URL = /([0-9a-f]{64})\.pdf$/;

/** Absolute URL of a datasheet, used both to download it and as its cache key. */
export function datasheetUrl(sha256, base, pageUrl) {
  return new URL(`${base}${sha256}.pdf`, pageUrl).href;
}

/** The SHA-256 a datasheet URL points to, or null. */
export function hashFromUrl(url) {
  return HASH_IN_URL.exec(url)?.[1] ?? null;
}

/** Set of hashes already in the datasheet cache. */
export async function savedHashes(cache) {
  const saved = new Set();
  for (const request of await cache.keys()) {
    const sha = hashFromUrl(request.url);
    if (sha) saved.add(sha);
  }
  return saved;
}
