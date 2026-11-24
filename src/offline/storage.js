// Device storage: how much room there is, asking the browser to keep our
// data, and the "last synced" time.
//
// Every browser call here is optional (older browsers lack some of them),
// so each function returns null when it can't answer instead of throwing.

const LAST_SYNCED_KEY = 'linecard.lastSynced';
const SPACE_MARGIN = 1.1; // want 10% more room than the files need

/** { usage, quota } in bytes, or null if the browser can't say. */
export async function getEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Is there room for `bytes` more?
 * Returns { enough: true|false|null, available }. null means "unknown", in
 * which case the download should just go ahead.
 */
export async function checkSpace(bytes) {
  const estimate = await getEstimate();
  if (!estimate || !estimate.quota) return { enough: null, available: null };
  const available = Math.max(estimate.quota - estimate.usage, 0);
  return { enough: available >= bytes * SPACE_MARGIN, available };
}

/**
 * Ask the browser not to clear our storage when the device runs low.
 * Without this, stored data is "best effort" and may be removed.
 * Returns true/false, or null if not supported.
 */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function isPersisted() {
  try {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/** Last time every datasheet was on the device, or null. */
export function getLastSynced() {
  try {
    const value = localStorage.getItem(LAST_SYNCED_KEY);
    return value ? new Date(value) : null;
  } catch {
    return null; // storage blocked (e.g. private mode)
  }
}

export function setLastSynced(date = new Date()) {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, date.toISOString());
  } catch {
    // Not worth failing a download over.
  }
}

// ---------------------------------------------------------------------------
// Update-check bookkeeping (see src/offline/updates.js).
// ---------------------------------------------------------------------------

const LAST_CHECKED_KEY = 'linecard.lastChecked';
const KEEP_EVERYTHING_KEY = 'linecard.keepEverything';

/** Last time the app checked for updated datasheets, or null. */
export function getLastChecked() {
  try {
    const value = localStorage.getItem(LAST_CHECKED_KEY);
    return value ? new Date(value) : null;
  } catch {
    return null;
  }
}

export function setLastChecked(date = new Date()) {
  try {
    localStorage.setItem(LAST_CHECKED_KEY, date.toISOString());
  } catch {
    // ignore
  }
}

/**
 * True once this device has had every datasheet. From then on, updates also
 * download datasheets for newly added parts, not just changed ones.
 */
export function getKeepEverything() {
  try {
    return localStorage.getItem(KEEP_EVERYTHING_KEY) === '1';
  } catch {
    return false;
  }
}

export function setKeepEverything() {
  try {
    localStorage.setItem(KEEP_EVERYTHING_KEY, '1');
  } catch {
    // ignore
  }
}
