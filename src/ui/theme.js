// Night mode: Automatic (follows the device's light/dark setting), Light or
// Dark. The choice lives on this device only. Light and Dark set
// data-theme on <html>; Automatic removes it, and CSS follows
// prefers-color-scheme (base.css). index.html applies a saved choice before
// the page draws, so opening the app in Dark never flashes white.

export const THEMES = [
  { id: 'auto', label: 'Automatic' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
const KEY = 'linecard.theme';

export function getTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme === 'light' || theme === 'dark') localStorage.setItem(KEY, theme);
    else localStorage.removeItem(KEY);
  } catch {
    // Not saved: it still applies until the app is closed.
  }
}
