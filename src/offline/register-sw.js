// Registers the service worker and handles app updates.
//
// Only the built app has a service worker (see src/sw.js for why). When a
// new version of the app is published, the browser downloads it in the
// background; it then waits, and this module shows an "Update ready" bar.
// Nothing changes until the rep taps Reload, so an update can't interrupt
// a customer demo.

import { el, button } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

export function registerServiceWorker(barContainer) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      showError(error, 'Offline mode could not be turned on');
      return;
    }

    // A new version was already waiting from an earlier visit.
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateBar(barContainer, registration.waiting);
    }
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      incoming?.addEventListener('statechange', () => {
        // "installed" + an existing controller = an update (not the first install).
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBar(barContainer, incoming);
        }
      });
    });

    // Check for a new version when the device comes back online.
    window.addEventListener('online', () => registration.update().catch(() => {}));
  });
}

function showUpdateBar(container, waitingWorker) {
  if (container.querySelector('.update-bar')) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  const bar = el(
    'div',
    { class: 'update-bar', role: 'status' },
    // Phones show the short text so the bar stays on one line (settings.css).
    el(
      'span',
      { class: 'update-text' },
      el('span', { class: 'update-text-long' }, 'A new version of the app is ready.'),
      el('span', { class: 'update-text-short' }, 'Update ready.'),
    ),
    button('Reload', () => waitingWorker.postMessage({ type: 'SKIP_WAITING' }), { primary: true }),
    button('Later', () => bar.remove()),
  );
  container.append(bar);
}

/** "3f9a1c2e" if the app is saved for offline use, or null. */
export async function getShellVersion() {
  try {
    const names = await caches.keys();
    const shell = names.find((name) => name.startsWith('shell-'));
    return shell ? shell.slice('shell-'.length) : null;
  } catch {
    return null;
  }
}
