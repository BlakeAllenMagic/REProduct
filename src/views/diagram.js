// Home screen: the receiver or transmitter block diagram (tabs), then every product type.
//
// The SVG is inserted inline (not as an <img>) so CSS can style it and each
// block can receive taps. For every block, categories.yaml (via linecard.json)
// decides which category it opens; blocks without parts are disabled.
// Most product types have no block (couplers, attenuators...), so a grid of
// buttons below the diagram lists them all.

import receiverSvg from '../diagram/receiver.svg?raw';
import transmitterSvg from '../diagram/transmitter.svg?raw';
import powerSvg from '../diagram/power.svg?raw';
import { DIAGRAMS, hrefFor } from '../router.js';
import { attachDiagramZoom } from '../ui/diagram-zoom.js';
import { browseSection } from './browse.js';
import { blockPinch } from '../ui/block-pinch.js';

const DRAWINGS = { receiver: receiverSvg, transmitter: transmitterSvg, power: powerSvg };
const TAB_NAMES = { receiver: 'Receiver', transmitter: 'Transmitter', power: 'Power' };
const STORAGE_KEY = 'linecard.diagram';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function renderDiagram(container, ctx, route = {}) {
  // #/transmitter or #/receiver picks one; plain #/ (e.g. "‹ Diagram" from a
  // parts table) shows the one used last on this device.
  const which = DIAGRAMS.includes(route.diagram) ? route.diagram : lastDiagram();
  rememberDiagram(which);

  container.append(diagramTabs(which));
  const wrap = document.createElement('div');
  wrap.className = 'diagram';
  wrap.id = 'diagram-panel';
  wrap.setAttribute('role', 'tabpanel');
  wrap.innerHTML = DRAWINGS[which];
  // Pinching zooms the drawing inside its card; the page itself doesn't zoom
  // here, so the top bar and tabs stay put (src/ui/diagram-zoom.js).
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn diagram-zoom-reset';
  reset.textContent = 'Reset zoom';
  const frame = document.createElement('div');
  frame.className = 'diagram-frame';
  frame.append(wrap, reset);
  container.append(frame);
  const detachZoom = attachDiagramZoom(wrap, reset);
  const detachPagePinch = blockPinch(document);
  document.documentElement.classList.add('no-page-zoom');

  for (const block of wrap.querySelectorAll('[data-block]')) {
    setUpBlock(block, ctx);
  }

  container.append(browseSection(ctx));
  // The top bar shows the firm's logo followed by "Line Card" (see main.js).
  return {
    title: 'G2CMI Line Card',
    logo: { alt: 'G2CMI', text: 'Line Card' },
    destroy() {
      detachZoom();
      detachPagePinch();
      document.documentElement.classList.remove('no-page-zoom');
    },
  };
}

/** Receiver | Transmitter switch. Links, so Back and swipe-back move between them. */
function diagramTabs(current) {
  const tabs = document.createElement('div');
  tabs.className = 'diagram-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Diagram');
  for (const name of DIAGRAMS) {
    const tab = document.createElement('a');
    tab.className = 'diagram-tab';
    tab.href = hrefFor('home', name);
    tab.textContent = TAB_NAMES[name];
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'diagram-panel');
    tab.setAttribute('aria-selected', String(name === current));
    // Replace rather than add a history entry: switching tabs back and forth
    // shouldn't make Back step through every switch.
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      location.replace(tab.href);
    });
    tabs.append(tab);
  }
  return tabs;
}

/**
 * The last diagram shown, kept in this device's localStorage. A convenience
 * only: if storage is blocked (private mode), it just starts on Receiver.
 */
function lastDiagram() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return DIAGRAMS.includes(saved) ? saved : DIAGRAMS[0];
  } catch {
    return DIAGRAMS[0];
  }
}

function rememberDiagram(name) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Not saved; nothing else depends on it.
  }
}

function setUpBlock(block, ctx) {
  const label = block.querySelector('.block-label')?.textContent ?? block.dataset.block;
  const category = ctx.categoryForBlock.get(block.dataset.block);
  const count = category ? ctx.partsByCategory.get(category.id).length : 0;

  if (!category || count === 0) {
    block.classList.add('is-disabled');
    block.setAttribute('aria-disabled', 'true');
    block.setAttribute('aria-label', `${label}: no parts on the line card`);
    return;
  }

  block.setAttribute('role', 'link');
  block.setAttribute('tabindex', '0');
  block.setAttribute('aria-label', `${label}: ${count} ${category.name}`);
  block.append(makeBadge(block, count));

  const open = () => {
    location.hash = hrefFor('category', category.id);
  };
  // `click` fires for mouse, trackpad and touch, so nothing depends on hover.
  block.addEventListener('click', open);
  block.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

/** A count bubble on the block's top-right corner. */
function makeBadge(block, count) {
  const rect = block.querySelector('.block-bg');
  const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) - 4;
  const y = Number(rect.getAttribute('y')) + 4;

  const badge = document.createElementNS(SVG_NS, 'g');
  badge.setAttribute('class', 'block-badge');
  badge.setAttribute('aria-hidden', 'true');

  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', x);
  circle.setAttribute('cy', y);
  circle.setAttribute('r', count >= 100 ? 20 : 16); // room for "445"

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  text.textContent = String(count);

  badge.append(circle, text);
  return badge;
}
