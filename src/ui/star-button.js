// ☆ / ★ button that adds a part to the shortlist or takes it off
// (src/shortlist.js). Used in the parts tables and on a part's page.
//
// syncStars(root) redraws every star under `root` after the list changes
// elsewhere (e.g. a part removed on the Shortlist screen), so a table needs
// one listener, not one per row.

import { shortlist } from '../shortlist.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function starIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function paint(button) {
  const on = shortlist.has(button.dataset.partId);
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${button.dataset.mpn} ${on ? 'from' : 'to'} the shortlist`);
}

export function starButton(part, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `star-button ${extraClass}`.trim();
  button.dataset.partId = part.id;
  button.dataset.mpn = part.mpn;
  button.append(starIcon());
  button.addEventListener('click', (event) => {
    event.stopPropagation(); // in a table row: star the part, don't open it
    shortlist.toggle(part.id);
  });
  paint(button);
  return button;
}

/** Redraw the stars under `root` when the shortlist changes. Returns a function that stops. */
export function watchStars(root) {
  const update = () => root.querySelectorAll('.star-button').forEach(paint);
  shortlist.addEventListener('change', update);
  return () => shortlist.removeEventListener('change', update);
}
