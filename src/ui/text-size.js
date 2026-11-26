// Text size of the parts tables: pinch on a table, or the A− / A+ buttons.
//
// One size for every table, remembered on this device. It's applied as the
// CSS variable --table-scale on <html>; table.css multiplies its font sizes
// and spacing by it. Row heights never drop below the 44 pt tap target.

export const TEXT_SIZE = { min: 0.6, max: 1.2, step: 0.1, default: 1 };
const STORAGE_KEY = 'linecard.tableScale';

/** Keep a size within limits, rounded to whole percent. */
export function clampSize(value) {
  if (!Number.isFinite(value)) return TEXT_SIZE.default;
  const clamped = Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value));
  return Math.round(clamped * 100) / 100;
}

/** The saved size, or 100% if none (or storage is blocked, e.g. private mode). */
export function readTextSize(storage = globalThis.localStorage) {
  try {
    const saved = Number.parseFloat(storage?.getItem(STORAGE_KEY));
    return Number.isFinite(saved) ? clampSize(saved) : TEXT_SIZE.default;
  } catch {
    return TEXT_SIZE.default;
  }
}

/** Save and apply a size; returns the size actually used. */
export function setTextSize(value, storage = globalThis.localStorage) {
  const size = clampSize(value);
  applyTextSize(size);
  try {
    storage?.setItem(STORAGE_KEY, String(size));
  } catch {
    // Not saved: it still applies until the app is closed.
  }
  return size;
}

export function applyTextSize(size) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--table-scale', String(size));
}
