// The app's one download manager, wired to the real browser, plus helpers
// the screens use to ask "what's on this device?".

import { config } from '../config.js';
import { DATASHEET_CACHE, datasheetUrl, savedHashes } from './caches.js';
import { DownloadManager, sha256Hex, sleep } from './download-manager.js';
import { requestPersist, setLastSynced } from './storage.js';

const urlFor = (sha) => datasheetUrl(sha, config.datasheetBase, document.baseURI);
const openCache = () => caches.open(DATASHEET_CACHE);

export const downloads = new DownloadManager({
  fetch: (url, init) => fetch(url, init),
  openCache,
  urlFor,
  sha256: sha256Hex,
  sleep,
  onFirstSave: () => requestPersist(),
  onSyncComplete: () => setLastSynced(),
});

/** Download items for a list of parts (parts without a datasheet are skipped). */
export function itemsForParts(parts) {
  return parts
    .filter((part) => part.datasheet?.sha256)
    .map((part) => ({ sha: part.datasheet.sha256, bytes: part.datasheet.bytes, label: part.mpn }));
}

/** Set of datasheet hashes on this device. Empty if storage isn't available. */
export async function getSavedHashes() {
  if (!('caches' in window)) return new Set();
  return savedHashes(await openCache());
}

/** The saved PDF for a part as a Response, or undefined. */
export async function getSavedDatasheet(part) {
  if (!part.datasheet?.sha256 || !('caches' in window)) return undefined;
  const cache = await openCache();
  return cache.match(urlFor(part.datasheet.sha256));
}
