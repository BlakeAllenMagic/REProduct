// Installing the app ("Add to Home Screen" / "Install app").
//
// - Chrome and Edge fire a `beforeinstallprompt` event when the app can be
//   installed. We keep it and show an "Install app" button in Settings.
// - Safari (iPad and Mac) has no such event or button, so we show
//   instructions instead: Share, then Add to Home Screen (iPad), or
//   File, then Add to Dock (Mac).
//
// Why it matters on iPad: a Home Screen app gets its own storage, separate
// from Safari. Datasheets downloaded in a Safari tab are NOT visible to the
// installed app, so the rep must install first, then download.

import { button, el } from './dom.js';

const HINT_DISMISSED_KEY = 'linecard.installHintDismissed';
let deferredPrompt = null;
const listeners = new Set();

/** Running as an installed app (not in a browser tab)? */
export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * 'ipad' | 'mac-safari' | 'other'.
 * iPadOS Safari reports itself as a Mac, so "Mac + touch screen" means iPad.
 * (Needs confirming on a real iPad: see the Apple device check.)
 */
export function platform() {
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|FxiOS|OPR/.test(ua);
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (isSafari && /Macintosh/.test(ua)) return 'mac-safari';
  return 'other';
}

/** Call once at startup, before the browser fires the event. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // we show our own button instead of the mini bar
    deferredPrompt = event;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((fn) => fn());
  });
}

export function canPromptInstall() {
  return deferredPrompt !== null;
}

export async function promptInstall() {
  if (!deferredPrompt) return;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  await prompt.prompt();
  listeners.forEach((fn) => fn());
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Short how-to text for this browser, or null if a button covers it. */
export function installInstructions() {
  switch (platform()) {
    case 'ipad':
      return 'In Safari, tap the Share button, then "Add to Home Screen". Then open the app from the Home Screen and download the datasheets there.';
    case 'mac-safari':
      return 'In Safari, choose File, then "Add to Dock". Then open the app from the Dock and download the datasheets there.';
    default:
      return canPromptInstall()
        ? null
        : 'Use the install icon in the address bar, or the browser menu (Chrome: "Cast, save and share", then "Install page as app"; Edge: "Apps", then "Install this site as an app").';
  }
}

/**
 * One-time banner on iPad or Mac Safari when the app isn't installed yet.
 * CLAUDE.md: Safari has no install prompt, so we explain it once.
 */
export function showInstallHintOnce(container) {
  if (isInstalled() || platform() === 'other') return;
  try {
    if (localStorage.getItem(HINT_DISMISSED_KEY)) return;
  } catch {
    return;
  }
  const dismiss = () => {
    try {
      localStorage.setItem(HINT_DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
    bar.remove();
  };
  const bar = el(
    'div',
    { class: 'update-bar install-hint', role: 'note' },
    el('span', {}, el('strong', {}, 'Install for offline use. '), installInstructions()),
    button('Got it', dismiss),
  );
  container.append(bar);
}
