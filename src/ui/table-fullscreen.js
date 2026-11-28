// Full-screen table: hides the app's top bar, the table toolbar and the
// download footer so more rows fit (a phone held sideways shows about three
// rows otherwise). Only the table and its header row stay, plus a small
// corner button to bring everything back.
//
// It's on for the table on screen only: leaving the table turns it off, so
// no other screen ever opens without its top bar (and Back button).

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLASS = 'table-fullscreen'; // on <html>; see table.css

/** Four corner arrows pointing out (enter) or in (exit). */
function icon(outward) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    outward
      ? 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
      : 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function iconButton(label, outward, onClick, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-icon ${extraClass}`;
  b.setAttribute('aria-label', label);
  b.append(icon(outward));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Returns { enter, exit, off }: the toolbar button, the corner button (add it
 * to the view), and a function that turns full screen off (call it when the
 * view goes away).
 */
export function tableFullscreen() {
  const set = (on) => {
    document.documentElement.classList.toggle(CLASS, on);
    exit.hidden = !on;
    if (on) exit.focus({ preventScroll: true });
    else enter.focus({ preventScroll: true });
  };
  const enter = iconButton('Full-screen table', true, () => set(true), 'table-fullscreen-enter');
  const exit = iconButton('Exit full screen', false, () => set(false), 'table-fullscreen-exit');
  exit.hidden = true;
  return {
    enter,
    exit,
    off() {
      document.documentElement.classList.remove(CLASS);
    },
  };
}
