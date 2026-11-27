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

  container.append(productTypes(ctx));
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

/**
 * "All product types": one button per category with its part count, under a
 * heading per group (RF, Power, ...) in the order categories.yaml lists them.
 * Without groups (older data), one grid in categories.yaml order.
 */
function productTypes(ctx) {
  const section = document.createElement('section');
  section.className = 'product-types';
  section.setAttribute('aria-labelledby', 'product-types-title');

  const heading = document.createElement('h2');
  heading.id = 'product-types-title';
  heading.textContent = 'All product types';
  section.append(heading);

  const all = [...ctx.categories.values()];
  if (!ctx.groups?.length) {
    section.append(productTypeGrid(all, ctx));
    return section;
  }

  // One block per group: its heading and its grid.
  const blocks = [];
  for (const group of ctx.groups) {
    const members = all.filter((c) => c.group === group);
    if (!members.length) continue;
    const block = document.createElement('div');
    block.className = 'product-group';
    block.dataset.group = group;
    const title = document.createElement('h3');
    title.className = 'product-group-title';
    title.textContent = group;
    block.append(title, productTypeGrid(members, ctx));
    blocks.push(block);
  }
  // Safety net: a type whose group isn't listed still shows (the build
  // rejects that, so this only matters for hand-made data).
  const strays = all.filter((c) => !ctx.groups.includes(c.group));
  if (strays.length) blocks.push(productTypeGrid(strays, ctx));

  // Filter chips: All, RF, Power... Shows one group at a time, remembered on this device.
  const chips = document.createElement('div');
  chips.className = 'product-group-filter';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Show product types');
  const show = (choice) => {
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.group === choice));
    for (const block of blocks) {
      block.hidden = choice !== ALL_GROUPS && block.dataset?.group !== choice;
    }
    section.classList.toggle('is-filtered', choice !== ALL_GROUPS);
    rememberGroup(choice);
  };
  for (const choice of [ALL_GROUPS, ...blocks.map((b) => b.dataset?.group).filter(Boolean)]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn filter-chip';
    chip.dataset.group = choice;
    chip.textContent = choice;
    chip.addEventListener('click', () => show(choice));
    chips.append(chip);
  }
  section.append(chips, ...blocks);
  const saved = lastGroup();
  show([...chips.children].some((c) => c.dataset.group === saved) ? saved : ALL_GROUPS);
  return section;
}

const ALL_GROUPS = 'All';
const GROUP_KEY = 'linecard.productGroup';

function lastGroup() {
  try {
    return localStorage.getItem(GROUP_KEY) ?? ALL_GROUPS;
  } catch {
    return ALL_GROUPS;
  }
}

function rememberGroup(group) {
  try {
    localStorage.setItem(GROUP_KEY, group);
  } catch {
    // Not saved; nothing else depends on it.
  }
}

function productTypeGrid(categories, ctx) {
  const list = document.createElement('ul');
  list.className = 'product-type-grid';
  for (const category of categories) {
    const count = ctx.partsByCategory.get(category.id).length;
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'product-type-name';
    name.textContent = category.name;
    const badge = document.createElement('span');
    badge.className = 'product-type-count';
    badge.textContent = String(count);

    if (count === 0) {
      // Not a link: nothing to open. Shown so the list matches the sheet's tabs.
      const box = document.createElement('span');
      box.className = 'product-type is-empty';
      box.setAttribute('aria-label', `${category.name}: no parts yet`);
      box.append(name, badge);
      item.append(box);
    } else {
      const link = document.createElement('a');
      link.className = 'product-type';
      link.href = hrefFor('category', category.id);
      link.setAttribute('aria-label', `${category.name}: ${count} parts`);
      link.append(name, badge);
      item.append(link);
    }
    list.append(item);
  }
  return list;
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
