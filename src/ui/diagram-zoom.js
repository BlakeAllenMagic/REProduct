// Pinch-to-zoom for the block diagram, inside its card (like a map), so the
// page itself never zooms and the top bar and tabs stay put.
//
// - The drawing is made wider (its width in px), not transformed: the card
//   then scrolls natively in both directions, and taps still land on the
//   right block at any zoom.
// - The card's height is locked while zoomed, so it scrolls instead of growing.
// - Pinch detection (Safari gesture events, touch, trackpad) is shared with
//   the PDF viewer: src/pdf/pinch.js.
// - A "Reset zoom" button shows while zoomed in.
// - At 1× the drawing fits the screen: as wide as its card allows, but no
//   taller than the space left below it, so no scrolling is needed to see it
//   all (fitWidth). Pinching zooms in from there.

import { attachPinch } from '../pdf/pinch.js';

export const DIAGRAM_ZOOM = { min: 1, max: 3 };

export function clampZoom(scale) {
  return Math.min(DIAGRAM_ZOOM.max, Math.max(DIAGRAM_ZOOM.min, scale));
}

/**
 * Where to scroll so the drawing point under the fingers stays under them.
 * scroll0: scroll offset when the pinch started; pad: the card's padding
 * (the drawing starts there); point: finger position inside the card's box;
 * from / to: zoom before and after. One axis at a time.
 */
export function scrollToKeep(scroll0, pad, point, from, to) {
  const drawingUnits = (scroll0 + point - pad) / from;
  return pad + drawingUnits * to - point;
}

/** Drawings are designed on a 1000-unit-wide grid; narrower ones (Power) keep the same scale. */
const DESIGN_WIDTH = 1000;
/** Never shrink below this height to fit a very short window (a phone held sideways). */
const MIN_HEIGHT = 180;

/**
 * The drawing's width in px at 1×: as wide as the card allows (a 1000-unit
 * drawing fills it), but short enough to fit the height from its top to the
 * bottom of the window. Pure, for tests.
 */
export function fitWidth({ viewBoxWidth, viewBoxHeight, innerWidth, availableHeight }) {
  const byWidth = innerWidth / DESIGN_WIDTH;
  const byHeight = Math.max(availableHeight, MIN_HEIGHT) / viewBoxHeight;
  return Math.floor(viewBoxWidth * Math.min(byWidth, byHeight));
}

/**
 * card: the scrolling box (.diagram) holding one <svg>; reset: the button.
 * Returns a function that removes the listeners.
 */
export function attachDiagramZoom(card, reset) {
  const svg = card.querySelector('svg');
  let zoom = 1;
  let baseWidth = 0; // the drawing's width in px at 1×
  let start = null; // { zoom, left, top } when the current pinch began

  const applyFit = () => {
    const style = getComputedStyle(card);
    const pad = (a, b) => parseFloat(style[a]) + parseFloat(style[b]);
    const box = svg.viewBox.baseVal;
    const top = card.getBoundingClientRect().top + window.scrollY;
    baseWidth = fitWidth({
      viewBoxWidth: box.width,
      viewBoxHeight: box.height,
      innerWidth: card.clientWidth - pad('paddingLeft', 'paddingRight'),
      availableHeight: window.innerHeight - top - pad('paddingTop', 'paddingBottom') - card.clientTop * 2 - 12,
    });
    svg.style.width = `${baseWidth}px`;
    svg.style.minWidth = '0';
  };

  const setZoom = (next, clientX, clientY, from = start) => {
    next = clampZoom(next);
    if (next === zoom && !from) return;
    if (zoom === 1) {
      card.style.height = `${card.offsetHeight}px`;
      card.classList.add('is-zoomed');
    }
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const x = clientX - rect.left - card.clientLeft;
    const y = clientY - rect.top - card.clientTop;
    const origin = from ?? { zoom, left: card.scrollLeft, top: card.scrollTop };
    zoom = next;
    svg.style.width = `${baseWidth * zoom}px`;
    svg.style.minWidth = '0';
    card.scrollLeft = scrollToKeep(origin.left, parseFloat(style.paddingLeft), x, origin.zoom, zoom);
    card.scrollTop = scrollToKeep(origin.top, parseFloat(style.paddingTop), y, origin.zoom, zoom);
    reset.hidden = false;
  };

  const resetZoom = () => {
    zoom = 1;
    start = null;
    card.style.height = '';
    card.classList.remove('is-zoomed');
    card.scrollLeft = 0;
    card.scrollTop = 0;
    reset.hidden = true;
    applyFit();
  };

  const detachPinch = attachPinch(card, {
    onChange(scale, x, y) {
      start ??= { zoom, left: card.scrollLeft, top: card.scrollTop };
      setZoom(start.zoom * scale, x, y);
    },
    onEnd() {
      start = null;
      if (zoom < 1.02) resetZoom(); // back to (about) full view: tidy up
    },
  });

  reset.addEventListener('click', resetZoom);
  // A rotation or a narrower/wider window changes the fit: start over.
  // (Only the width: a Safari tab also "resizes" its height when its toolbar
  // slides away while scrolling, and the drawing shouldn't jump then.)
  let width = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    resetZoom();
  };
  window.addEventListener('resize', onResize);
  resetZoom();

  return () => {
    detachPinch();
    reset.removeEventListener('click', resetZoom);
    window.removeEventListener('resize', onResize);
  };
}
