// The app's one download manager, wired to the real browser, plus helpers
// the screens use to ask "what's on this device?".

import { config } from '../config.js';
import { DATASHEET_CACHE, datasheetKey, datasheetUrl, savedHashes } from './caches.js';
import { DownloadManager, sha256Hex, sleep } from './download-manager.js';
import { rememberSaved } from './saved-parts.js';
import { requestPersist, setLastSynced } from './storage.js';

// Downloaded from the datasheet site (config.datasheetBase), but always saved
// under the same key on this device, whichever site it came from.
const urlFor = (sha) => datasheetUrl(sha, config.datasheetBase, document.baseURI);
const keyFor = (sha) => datasheetKey(sha, document.baseURI);
const openCache = () => caches.open(DATASHEET_CACHE);

export const downloads = new DownloadManager({
  fetch: (url, init) => fetch(url, init),
  openCache,
  urlFor,
  keyFor,
  sha256: sha256Hex,
  sleep,
  onFirstSave: () => requestPersist(),
  onSyncComplete: () => setLastSynced(),
});

// Remember which parts each saved file belongs to (see saved-parts.js).
downloads.addEventListener('saved', (event) => rememberSaved(event.detail.item?.partIds, event.detail.sha));

/**
 * Download items for a list of parts. Parts without a datasheet are
 * skipped; parts sharing one PDF become one item listing all their ids.
 */
export function itemsForParts(parts) {
  const bySha = new Map();
  for (const part of parts) {
    const sha = part.datasheet?.sha256;
    if (!sha) continue;
    const item = bySha.get(sha);
    if (item) item.partIds.push(part.id);
    else bySha.set(sha, { sha, bytes: part.datasheet.bytes, label: part.mpn, partIds: [part.id] });
  }
  return [...bySha.values()];
}

/** Set of datasheet hashes on this device. Empty if storage isn't available. */
export async function getSavedHashes() {
  if (!('caches' in window)) return new Set();
  return savedHashes(await openCache());
}

/** The saved PDF with this hash as a Response, or undefined. */
export async function getSavedFile(sha) {
  if (!sha || !('caches' in window)) return undefined;
  const cache = await openCache();
  return cache.match(keyFor(sha));
}

/** The saved PDF for a part's current datasheet, or undefined. */
export function getSavedDatasheet(part) {
  return getSavedFile(part.datasheet?.sha256);
}
