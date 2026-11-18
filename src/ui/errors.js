// One place to show errors to the user. CLAUDE.md: async errors are caught
// and shown in the UI, never swallowed silently.

let banner;

/** Show an error message in the banner at the top of the screen. */
export function showError(error, context = '') {
  console.error(context, error);
  if (!banner) return;
  const message = error instanceof Error ? error.message : String(error);
  const item = document.createElement('div');
  item.className = 'error-item';
  item.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.textContent = context ? `${context}: ${message}` : message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'error-close';
  close.setAttribute('aria-label', 'Dismiss error');
  close.textContent = '×';
  close.addEventListener('click', () => item.remove());

  item.append(text, close);
  banner.append(item);
}

/** Connect the banner element and catch anything that slips through. */
export function installErrorHandling(bannerElement) {
  banner = bannerElement;
  window.addEventListener('error', (event) => showError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => showError(event.reason));
}
