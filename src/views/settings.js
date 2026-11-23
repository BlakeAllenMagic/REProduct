// Settings: what's on this device, downloads, storage, app info.

import { formatBytes } from '../format.js';
import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { getEstimate, getLastSynced, isPersisted } from '../offline/storage.js';
import { hrefFor } from '../router.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

export function renderSettings(container, ctx) {
  const screen = new SettingsScreen(container, ctx);
  screen.refresh();
  return {
    title: 'Settings',
    back: { href: hrefFor('home'), label: 'Diagram' },
    destroy: () => screen.destroy(),
  };
}

class SettingsScreen {
  constructor(container, ctx) {
    this.container = container;
    this.ctx = ctx;
    this.lastRun = null; // detail of the last 'finished' event while open
    this.onProgress = (e) => this.renderDownloads(e.detail);
    this.onFinished = (e) => {
      this.lastRun = e.detail;
      this.refresh();
    };
    // Recount saved files as they land, at most twice a second.
    this.onSaved = () => {
      if (this.refreshTimer) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refresh();
      }, 500);
    };
    downloads.addEventListener('progress', this.onProgress);
    downloads.addEventListener('finished', this.onFinished);
    downloads.addEventListener('saved', this.onSaved);

    this.sections = {
      datasheets: el('section', { class: 'card', 'aria-labelledby': 'h-datasheets' }),
      progress: el('div', { class: 'download-progress', 'aria-live': 'polite' }),
      storage: el('section', { class: 'card', 'aria-labelledby': 'h-storage' }),
      install: el('section', { class: 'card', 'aria-labelledby': 'h-install', hidden: true }),
      about: el('section', { class: 'card', 'aria-labelledby': 'h-about' }),
    };
    container.append(el('div', { class: 'settings' }, ...Object.values(this.sections)));
  }

  /** Re-read everything (saved files, storage) and redraw. */
  async refresh() {
    try {
      const [saved, estimate, persisted] = await Promise.all([
        getSavedHashes(),
        getEstimate(),
        isPersisted(),
      ]);
      if (this.destroyed) return;
      this.saved = saved;
      this.renderDatasheets();
      this.renderDownloads(downloads.state);
      this.renderStorage(estimate, persisted);
      this.renderAbout();
    } catch (error) {
      showError(error, `Couldn't read this device's storage`);
    }
  }

  renderDatasheets() {
    const all = itemsForParts(this.ctx.linecard.parts);
    const unique = new Map(all.map((i) => [i.sha, i]));
    const savedItems = [...unique.values()].filter((i) => this.saved.has(i.sha));
    const savedBytes = savedItems.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    const totalBytes = [...unique.values()].reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    const allSaved = savedItems.length === unique.size;
    const lastSynced = getLastSynced();
    const noDatasheet = this.ctx.linecard.parts.length - all.length;

    const rows = [...this.ctx.categories.values()].map((category) => {
      const parts = this.ctx.partsByCategory.get(category.id);
      const items = itemsForParts(parts);
      const done = items.filter((i) => this.saved.has(i.sha)).length;
      return el(
        'li',
        { class: 'category-row' },
        el('span', { class: 'category-name' }, category.name),
        el('span', { class: 'category-count' }, `${done} of ${items.length} saved`),
        button('Download', () => downloadParts(parts), {
          disabled: done === items.length || downloads.running,
          'aria-label': `Download ${category.name} datasheets`,
        }),
      );
    });

    this.sections.datasheets.replaceChildren(
      el('h2', { id: 'h-datasheets' }, 'Datasheets on this device'),
      el(
        'p',
        { class: 'big-stat' },
        `${savedItems.length} of ${unique.size}`,
        el('span', {}, ` saved (${formatBytes(savedBytes)} of ${formatBytes(totalBytes)})`),
      ),
      el(
        'p',
        { class: 'muted' },
        lastSynced
          ? `Last synced ${lastSynced.toLocaleString()}.`
          : 'Not fully synced yet on this device.',
        noDatasheet ? ` ${noDatasheet} parts have no datasheet in the app yet.` : '',
      ),
      button(allSaved ? 'All datasheets saved' : 'Download all', () => downloadParts(this.ctx.linecard.parts), {
        primary: true,
        disabled: allSaved || downloads.running,
      }),
      el('ul', { class: 'category-list' }, rows),
      this.sections.progress,
    );
  }

  renderDownloads(state) {
    const box = this.sections.progress;
    if (!state.running && !this.lastRun) {
      box.replaceChildren();
      return;
    }
    const s = state.running ? state : this.lastRun;
    const percent = s.bytesTotal ? Math.round((s.bytesDone / s.bytesTotal) * 100) : 100;
    const children = [
      el(
        'div',
        { class: 'progress-line' },
        el('strong', {}, state.running ? 'Downloading…' : summary(s)),
        el('span', {}, `${s.done} / ${s.total} files · ${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)}`),
      ),
      el('progress', { max: 100, value: Math.min(percent, 100), 'aria-label': 'Download progress' }),
    ];
    if (state.running) {
      children.push(button('Cancel', () => downloads.cancel()));
    }
    if (s.error) children.push(el('p', { class: 'error-text' }, s.error));
    if (s.quotaExceeded) {
      children.push(
        el(
          'p',
          { class: 'error-text' },
          'The device ran out of storage space. Datasheets already saved are kept. ' +
            'Free up space on the device, then tap "Retry failed".',
        ),
      );
    }
    if (s.failed.length) {
      children.push(
        el('h3', {}, `${s.failed.length} failed`),
        el(
          'ul',
          { class: 'error-list' },
          s.failed.map((f) => el('li', {}, el('strong', {}, f.label), ` ${f.error}`)),
        ),
      );
      if (!state.running) children.push(button('Retry failed', () => downloads.retryFailed()));
    }
    box.replaceChildren(...children);
  }

  renderStorage(estimate, persisted) {
    const lines = [];
    if (estimate) {
      lines.push(
        el('p', {}, `Used by this app: ${formatBytes(estimate.usage)}`),
        el('p', {}, `Available to this app: ${formatBytes(Math.max(estimate.quota - estimate.usage, 0))}`),
      );
    } else {
      lines.push(el('p', { class: 'muted' }, 'This browser does not report storage use.'));
    }
    const persistText = {
      true: 'On. The browser will not clear saved datasheets to free up space.',
      false:
        'Off. The browser may clear saved datasheets if the device runs low on space. ' +
        'It turns on automatically after the first download where the browser allows it ' +
        '(installing the app helps).',
      null: 'Not supported by this browser.',
    }[String(persisted)];
    lines.push(el('p', {}, el('strong', {}, 'Keep data: '), persistText));
    this.sections.storage.replaceChildren(el('h2', { id: 'h-storage' }, 'Storage'), ...lines);
  }

  renderAbout() {
    const version = this.ctx.linecard.dataVersion;
    const date = new Date(version);
    this.sections.about.replaceChildren(
      el('h2', { id: 'h-about' }, 'About'),
      el('p', {}, `Line card data: ${Number.isNaN(date.getTime()) ? version : date.toLocaleString()}`),
      el('p', {}, `${this.ctx.linecard.parts.length} parts in ${this.ctx.categories.size} categories`),
    );
  }

  destroy() {
    this.destroyed = true;
    downloads.removeEventListener('progress', this.onProgress);
    downloads.removeEventListener('finished', this.onFinished);
    downloads.removeEventListener('saved', this.onSaved);
    clearTimeout(this.refreshTimer);
  }
}

function summary(s) {
  if (s.cancelled) return 'Download cancelled';
  if (s.quotaExceeded) return 'Stopped: storage full';
  if (s.error) return 'Download stopped';
  if (s.failed.length) return 'Finished with errors';
  return 'Download complete';
}
