// App entry: load the data, then show whichever view the URL asks for.

import { config } from './config.js';
import { indexLinecard } from './data.js';
import { startRouter } from './router.js';
import { registerServiceWorker } from './offline/register-sw.js';
import { installUpdates } from './offline/updates.js';
import { installDownloadChip } from './ui/download-chip.js';
import { el } from './ui/dom.js';
import { installErrorHandling, showError } from './ui/errors.js';
import { installTopbarFit } from './ui/fit-topbar.js';
import { captureInstallPrompt, showInstallHintOnce } from './ui/install.js';
import { installSearch } from './ui/search-panel.js';
import { renderDiagram } from './views/diagram.js';
import { renderPartsTable } from './views/parts-table.js';
import { renderSettings } from './views/settings.js';
import { renderViewer } from './views/viewer.js';

const els = {
  view: document.getElementById('view'),
  title: document.getElementById('title'),
  back: document.getElementById('back'),
  backLabel: document.getElementById('back-label'),
  actions: document.getElementById('actions'),
  settingsLink: document.getElementById('settings-link'),
};

const views = {
  home: renderDiagram,
  category: renderPartsTable,
  part: renderViewer,
  settings: renderSettings,
};

let current = null; // { destroy } of the view on screen
let renderCount = 0; // detects a newer navigation finishing first

async function loadLinecard() {
  const response = await fetch(config.linecardUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Couldn't load line card data (HTTP ${response.status})`);
  return indexLinecard(await response.json());
}

/**
 * Each view is a function (container, ctx, route) that fills the container and
 * returns (or resolves to) { title, back: { href, label }, actions, destroy }.
 */
async function show(ctx, route) {
  const myRender = ++renderCount;
  current?.destroy?.();
  current = null;
  els.view.replaceChildren();
  els.actions.replaceChildren();
  els.view.dataset.view = route.name;
  els.settingsLink.hidden = route.name === 'settings';
  window.scrollTo(0, 0);

  try {
    const result = await views[route.name](els.view, ctx, route);
    if (myRender !== renderCount) {
      // The user navigated again while this view was loading.
      result?.destroy?.();
      return;
    }
    current = result;
    if (result?.logo) {
      // Home screen: the rep firm's logo instead of the title text. The image
      // ships with the app (public/brand/), so it's cached for offline use.
      // Reads as "G2CMI Line Card", with the logo standing in for "G2CMI".
      els.title.replaceChildren(
        el('img', { class: 'topbar-logo', src: 'brand/logo.png', alt: result.logo.alt, width: 360, height: 176 }),
        el('span', { class: 'topbar-logo-text' }, ` ${result.logo.text}`),
      );
    } else {
      els.title.textContent = result?.title ?? 'RF Line Card';
    }
    document.title = result?.logo ? result.title : result?.title ? `${result.title} · RF Line Card` : 'RF Line Card';
    if (result?.back) {
      els.back.href = result.back.href;
      els.backLabel.textContent = result.back.label;
      els.back.hidden = false;
    } else {
      els.back.hidden = true;
    }
    if (result?.actions) els.actions.append(...result.actions);
  } catch (error) {
    if (myRender === renderCount) showError(error, `Couldn't open this screen`);
  }
}

async function start() {
  installErrorHandling(document.getElementById('errors'));
  installTopbarFit(document.querySelector('.topbar'));
  installDownloadChip(document.getElementById('download-chip'));
  // Before loading data, so offline support turns on even if loading fails.
  registerServiceWorker(document.getElementById('banners'));
  captureInstallPrompt();
  showInstallHintOnce(document.getElementById('banners'));
  let ctx;
  try {
    ctx = await loadLinecard();
  } catch (error) {
    showError(error);
    return;
  }
  installSearch(document.getElementById('search-button'), ctx);
  startRouter((route) => show(ctx, route));
  // Quietly fetch updated datasheets when online (src/offline/updates.js).
  installUpdates(ctx, document.getElementById('banners'));
}

start();
