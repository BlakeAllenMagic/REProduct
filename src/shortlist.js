// The shortlist: parts starred during a meeting, to send all their datasheets
// in one email at the end (src/views/shortlist.js).
//
// Kept on this device (localStorage) until the rep clears it, so it survives
// closing the app and can be built before a visit. Only part ids are stored;
// a part that later leaves the line card is simply skipped.

const KEY = 'linecard.shortlist';

class Shortlist extends EventTarget {
  constructor() {
    super();
    this.ids = load();
  }

  has(id) {
    return this.ids.includes(id);
  }

  /** Add or remove a part. Returns true if it's now on the list. */
  toggle(id) {
    if (this.has(id)) this.remove(id);
    else this.update([...this.ids, id]);
    return this.has(id);
  }

  remove(id) {
    this.update(this.ids.filter((x) => x !== id));
  }

  clear() {
    this.update([]);
  }

  /** Drop parts no longer on the line card (removed from the Sheet), so the count stays right. */
  keepOnly(knownIds) {
    const kept = this.ids.filter((id) => knownIds.has(id));
    if (kept.length !== this.ids.length) this.update(kept);
  }

  /** The parts on the list that are still on the line card, in the order they were added. */
  parts(ctx) {
    return this.ids.map((id) => ctx.parts.get(id)).filter(Boolean);
  }

  update(ids) {
    this.ids = ids;
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      // Not saved (private browsing, storage full): it still works until the app closes.
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { ids } }));
  }
}

function load() {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const shortlist = new Shortlist();
