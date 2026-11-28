// Settings: what's on this device, downloads, storage, app info.

import { formatBytes } from '../format.js';
import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { getShellVersion } from '../offline/register-sw.js';
import { getEstimate, getLastChecked, getLastSynced, isPersisted } from '../offline/storage.js';
import { checkForUpdates } from '../offline/updates.js';
import { hrefFor } from '../router.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';
import { getTheme, setTheme, THEMES } from '../ui/theme.js';
import {
  canPromptInstall,
  installInstructions,
  isInstalled,
  onInstallChange,
  platform,
  promptInstall,
} from '../ui/install.js';

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
    this.stopInstallWatch = onInstallChange(() => this.renderInstall());
    this.onStorageChanged = () => this.refresh();
    window.addEventListener('linecard:storage-changed', this.onStorageChanged);

    this.sections = {
      datasheets: el('section', { class: 'card', 'aria-labelledby': 'h-datasheets' }),
      progress: el('div', { class: 'download-progress', 'aria-live': 'polite' }),
      sheet: el('section', { class: 'card', 'aria-labelledby': 'h-sheet' }),
      storage: el('section', { class: 'card', 'aria-labelledby': 'h-storage' }),
      install: el('section', { class: 'card', 'aria-labelledby': 'h-install', hidden: true }),
      appearance: el('section', { class: 'card', 'aria-labelledby': 'h-appearance' }),
      about: el('section', { class: 'card', 'aria-labelledby': 'h-about' }),
    };
    container.append(el('div', { class: 'settings' }, ...Object.values(this.sections)));
    this.renderAppearance();
  }

  /** Night mode: Automatic / Light / Dark (src/ui/theme.js). */
  renderAppearance() {
    const current = getTheme();
    const choices = el(
      'div',
      { class: 'theme-choices', role: 'group', 'aria-labelledby': 'h-appearance' },
      THEMES.map((theme) =>
        button(theme.label, () => {
          setTheme(theme.id);
          this.renderAppearance();
        }, { class: 'btn filter-chip', 'aria-pressed': String(theme.id === current) }),
      ),
    );
    this.sections.appearance.replaceChildren(
      el('h2', { id: 'h-appearance' }, 'Appearance'),
      choices,
      el('p', { class: 'message-note' }, 'Automatic follows the light or dark setting of this device. Datasheets always show as printed.'),
    );
  }

  /** Re-read everything (saved files, storage) and redraw. */
  async refresh() {
    try {
      const [saved, estimate, persisted, shellVersion, sheetStatus] = await Promise.all([
        getSavedHashes(),
        getEstimate(),
        isPersisted(),
        getShellVersion(),
        loadSheetStatus(),
      ]);
      if (this.destroyed) return;
      this.saved = saved;
      this.renderDatasheets();
      this.renderDownloads(downloads.state);
      this.renderSheet(sheetStatus);
      this.renderStorage(estimate, persisted);
      this.renderInstall();
      this.renderAbout(shellVersion);
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
      button(unique.size === 0 ? 'No datasheets to download' : allSaved ? 'All datasheets saved' : 'Download all', () => downloadParts(this.ctx.linecard.parts), {
        primary: true,
        disabled: allSaved || downloads.running,
      }),
      this.renderUpdateCheck(),
      this.sections.progress,
    );
  }

  /** "Check for updates" button, last-checked time and the last result. */
  renderUpdateCheck() {
    const lastChecked = getLastChecked();
    const result = el('span', { class: 'muted', 'aria-live': 'polite' }, this.updateMessage ?? '');
    const check = button('Check for updates', async () => {
      check.disabled = true;
      result.textContent = 'Checking…';
      const outcome = await checkForUpdates({ fetchLinecard: true });
      this.updateMessage = {
        offline: 'Offline. Updates are checked automatically when you are back online.',
        'up-to-date': 'Everything is up to date.',
        downloading: `Downloading ${outcome.count} updated datasheet${outcome.count === 1 ? '' : 's'}.`,
        error: 'The check failed (see the message at the top).',
      }[outcome.status];
      if (!this.destroyed) this.refresh();
    });
    return el(
      'div',
      { class: 'update-check' },
      check,
      el('span', { class: 'muted' }, lastChecked ? `Last checked ${lastChecked.toLocaleString()}.` : 'Not checked yet.'),
      result,
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

  /**
   * The Google Sheet import, from public/import-status.json (written by
   * tools/import_sheet.py): when the parts list last changed, or the
   * problems that stop the sheet from being imported.
   */
  renderSheet(status) {
    const children = [
      el('h2', { id: 'h-sheet' }, 'Parts sheet'),
      el('p', { class: 'muted' }, 'The parts list is edited in the Google Sheet. Changes appear here within about 2 hours.'),
    ];
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : null);
    if (!status) {
      children.push(el('p', { class: 'muted' }, 'Import status not available.'));
    } else if (status.ok) {
      children.push(
        el(
          'p',
          { class: 'sheet-ok' },
          status.importedAt ? `Up to date. Last change imported ${when(status.importedAt)}.` : 'Up to date.',
        ),
      );
    } else {
      const count = status.problems.length;
      children.push(
        el(
          'p',
          { class: 'error-text' },
          el('strong', {}, `The sheet has ${count} problem${count === 1 ? '' : 's'} to fix. `),
          'Until they are fixed, the app keeps showing the last good version of the parts list',
          status.importedAt ? ` (from ${when(status.importedAt)}).` : '.',
        ),
        el('ul', { class: 'error-list sheet-problems' }, status.problems.map((p) => el('li', {}, p))),
      );
    }
    if (status?.warnings?.length) {
      children.push(
        el('p', {}, el('strong', {}, 'Worth checking:')),
        el('ul', { class: 'sheet-warnings' }, status.warnings.map((w) => el('li', {}, w))),
      );
    }
    this.sections.sheet.replaceChildren(...children);
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

  renderInstall() {
    const section = this.sections.install;
    section.hidden = false;
    const children = [el('h2', { id: 'h-install' }, 'Install')];
    if (isInstalled()) {
      children.push(el('p', {}, 'Running as an installed app.'));
    } else {
      children.push(
        el('p', {}, 'Not installed. Installing gives the app its own window and keeps it working offline.'),
      );
      if (canPromptInstall()) children.push(button('Install app', () => promptInstall(), { primary: true }));
      const howTo = installInstructions();
      if (howTo) children.push(el('p', { class: 'muted' }, howTo));
      if (platform() === 'ipad') {
        children.push(
          el(
            'p',
            { class: 'error-text' },
            'Datasheets downloaded in this Safari tab will not be in the installed app. Install first, then download.',
          ),
        );
      }
    }
    section.replaceChildren(...children);
  }

  renderAbout(shellVersion) {
    const version = this.ctx.linecard.dataVersion;
    const date = new Date(version);
    let appLine;
    if (import.meta.env.DEV) appLine = 'Development build: offline mode is off (it runs in the built app only).';
    else if (shellVersion) appLine = `App version ${shellVersion}, saved for offline use.`;
    else appLine = 'App not saved for offline use yet. Reload once while online.';
    this.sections.about.replaceChildren(
      el('h2', { id: 'h-about' }, 'About'),
      el('p', {}, appLine),
      el('p', {}, `Line card data: ${Number.isNaN(date.getTime()) ? version : date.toLocaleString()}`),
      el('p', {}, `${this.ctx.linecard.parts.length} parts in ${this.ctx.categories.size} categories`),
    );
  }

  destroy() {
    this.destroyed = true;
    downloads.removeEventListener('progress', this.onProgress);
    downloads.removeEventListener('finished', this.onFinished);
    downloads.removeEventListener('saved', this.onSaved);
    this.stopInstallWatch();
    window.removeEventListener('linecard:storage-changed', this.onStorageChanged);
    clearTimeout(this.refreshTimer);
  }
}

/** public/import-status.json, or null if it can't be read. */
async function loadSheetStatus() {
  try {
    const response = await fetch('./import-status.json', { cache: 'no-cache' });
    if (!response.ok) return null;
    const status = await response.json();
    return Array.isArray(status?.problems) ? status : null;
  } catch {
    return null; // offline before the first install, for example
  }
}

function summary(s) {
  if (s.cancelled) return 'Download cancelled';
  if (s.quotaExceeded) return 'Stopped: storage full';
  if (s.error) return 'Download stopped';
  if (s.failed.length) return 'Finished with errors';
  return 'Download complete';
}
