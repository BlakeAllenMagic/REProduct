// The in-app update flow (CLAUDE.md, "Update flow when online").
//
// When the device is online, the app quietly:
//   1. loads the latest linecard.json (the service worker tries the network
//      first, with a 3 second limit, then falls back to the saved copy);
//   2. compares its datasheet hashes with what's saved on the device;
//   3. downloads only the changed (or, in keep-everything mode, new) ones,
//      through the same verified download manager as "Download all";
//   4. deletes old versions only once nothing needs them any more.
//
// It runs when the app starts, when the device comes back online, when the
// app is reopened after 6+ hours, and from Settings > Check for updates.

import { config } from '../config.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';
import { deleteSavedFiles, downloads, getSavedHashes, itemsForParts } from './downloads.js';
import { filesToDelete, hasEverything, partsToUpdate } from './update-plan.js';
import { backfillSavedParts, readSavedParts } from './saved-parts.js';
import { getKeepEverything, getLastChecked, setKeepEverything, setLastChecked, setLastSynced } from './storage.js';

const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;

let ctx; // the line card the screens are showing
let latest; // the newest line card seen (may be newer than ctx until reload)
let banners;
let running = null;

/** Call once at startup, after the line card has loaded. */
export function installUpdates(loadedCtx, bannerContainer) {
  ctx = loadedCtx;
  latest = loadedCtx.linecard;
  banners = bannerContainer;

  // Whenever a download run ends, check whether the device now has
  // everything ("last synced", keep-everything mode) and tidy old versions.
  downloads.addEventListener('finished', () => tidyUp().catch((error) => showError(error, 'Update cleanup failed')));

  window.addEventListener('online', () => checkForUpdates({ fetchLinecard: true }));
  document.addEventListener('visibilitychange', () => {
    const last = getLastChecked();
    if (document.visibilityState === 'visible' && (!last || Date.now() - last.getTime() > RECHECK_AFTER_MS)) {
      checkForUpdates({ fetchLinecard: true });
    }
  });

  // At startup the line card was just loaded (network first), so no refetch.
  checkForUpdates({ fetchLinecard: false });
}

/**
 * Check for and download updated datasheets. Safe to call any time; calls
 * while one is running share it. Resolves to a short summary for Settings.
 */
export function checkForUpdates({ fetchLinecard = true } = {}) {
  running ??= run(fetchLinecard).finally(() => {
    running = null;
  });
  return running;
}

async function run(fetchLinecard) {
  if (!navigator.onLine) return { status: 'offline' };
  try {
    if (fetchLinecard) await refreshLinecard();
    const parts = latest.parts;
    const saved = await getSavedHashes();
    const savedParts = backfillSavedParts(parts, saved);
    const todo = partsToUpdate(parts, saved, savedParts, getKeepEverything());
    setLastChecked();
    if (todo.length === 0) {
      await tidyUp();
      return { status: 'up-to-date' };
    }
    // Quiet: no space question. If storage runs out, the download manager
    // stops and Settings shows the message; nothing saved is lost.
    downloads.download(itemsForParts(todo));
    return { status: 'downloading', count: new Set(todo.map((p) => p.datasheet.sha256)).size };
  } catch (error) {
    showError(error, `Couldn't check for updated datasheets`);
    return { status: 'error' };
  }
}

/** Fetch linecard.json; if it's newer than what's on screen, offer a reload. */
async function refreshLinecard() {
  const response = await fetch(config.linecardUrl, { cache: 'no-cache' });
  if (!response.ok) return;
  const fresh = await response.json();
  if (!Array.isArray(fresh?.parts) || fresh.dataVersion === latest.dataVersion) return;
  latest = fresh;
  if (fresh.dataVersion !== ctx.linecard.dataVersion) showReloadBar();
}

/** After downloads: record "everything saved", delete unneeded old versions. */
async function tidyUp() {
  if (downloads.running) return; // wait until the whole run is over
  const parts = latest.parts;
  const saved = await getSavedHashes();
  if (hasEverything(parts, saved)) {
    setLastSynced();
    setKeepEverything();
  }
  await deleteSavedFiles(filesToDelete(parts, saved, readSavedParts()));
  // Settings listens for this to refresh its counts and "Last synced".
  window.dispatchEvent(new Event('linecard:storage-changed'));
}

function showReloadBar() {
  if (!banners || banners.querySelector('.linecard-update')) return;
  const bar = el(
    'div',
    { class: 'update-bar linecard-update', role: 'status' },
    el('span', {}, 'The line card was updated.'),
    button('Reload', () => window.location.reload(), { primary: true }),
    button('Later', () => bar.remove()),
  );
  banners.append(bar);
}
