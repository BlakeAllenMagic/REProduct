// Under the diagram: the whole line card, browsed one of two ways.
//
//   By Product Type   every product type with its part count, under the
//                     groups from categories.yaml (RF, Power...)
//   By Manufacturer   each manufacturer with the product types it makes;
//                     a tap opens that table showing only its parts
//                     (#/category/<id>/<manufacturer>)
//
// Each way has chips (All, RF, Power... or All, pSemi...) to show one group
// at a time. The chosen way and chip are remembered on this device.

import { hrefFor } from '../router.js';

const ALL = 'All';
const MODES = [
  { id: 'type', label: 'By Product Type' },
  { id: 'manufacturer', label: 'By Manufacturer' },
];
const MODE_KEY = 'linecard.browseMode';
const CHIP_KEY = { type: 'linecard.productGroup', manufacturer: 'linecard.manufacturer' };

export function browseSection(ctx) {
  const section = document.createElement('section');
  section.className = 'product-types';
  section.setAttribute('aria-label', 'Browse the line card');

  const switcher = document.createElement('div');
  switcher.className = 'diagram-tabs browse-tabs';
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', 'Browse');
  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('role', 'tabpanel');

  const show = (mode) => {
    for (const tab of switcher.children) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    body.replaceChildren(...(mode === 'manufacturer' ? byManufacturer(ctx) : byType(ctx)));
    remember(MODE_KEY, mode);
  };
  for (const mode of MODES) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'diagram-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.mode = mode.id;
    tab.textContent = mode.label;
    tab.addEventListener('click', () => show(mode.id));
    switcher.append(tab);
  }
  section.append(switcher, body);
  const saved = recall(MODE_KEY);
  show(MODES.some((m) => m.id === saved) ? saved : 'type');
  return section;
}

/** Product types under their groups (RF, Power...). */
function byType(ctx) {
  const all = [...ctx.categories.values()];
  const item = (c) => ({ name: c.name, count: ctx.partsByCategory.get(c.id).length, href: hrefFor('category', c.id) });
  if (!ctx.groups?.length) return [grid(all.map(item))];
  const blocks = [];
  for (const group of ctx.groups) {
    const members = all.filter((c) => c.group === group);
    if (members.length) blocks.push(block(group, members.map(item)));
  }
  // Safety net: a type whose group isn't listed still shows (the build
  // rejects that, so this only matters for hand-made data).
  const strays = all.filter((c) => !ctx.groups.includes(c.group));
  if (strays.length) blocks.push(grid(strays.map(item)));
  return [chipFilter(blocks, CHIP_KEY.type), ...blocks];
}

/** Each manufacturer with the product types it makes (only those with parts). */
function byManufacturer(ctx) {
  const counts = new Map(); // manufacturer -> Map(category id -> count)
  for (const [id, parts] of ctx.partsByCategory) {
    for (const part of parts) {
      if (!counts.has(part.manufacturer)) counts.set(part.manufacturer, new Map());
      const byType = counts.get(part.manufacturer);
      byType.set(id, (byType.get(id) ?? 0) + 1);
    }
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const blocks = names.map((name) => {
    const items = [...ctx.categories.values()]
      .filter((c) => counts.get(name).has(c.id))
      .map((c) => ({ name: c.name, count: counts.get(name).get(c.id), href: hrefFor('category', c.id, name) }));
    return block(name, items);
  });
  return [chipFilter(blocks, CHIP_KEY.manufacturer), ...blocks];
}

/** A heading and its grid; `data-group` is what the chips match. */
function block(title, items) {
  const wrap = document.createElement('div');
  wrap.className = 'product-group';
  wrap.dataset.group = title;
  const heading = document.createElement('h3');
  heading.className = 'product-group-title';
  heading.textContent = title;
  wrap.append(heading, grid(items));
  return wrap;
}

/** Chips (All + one per block) that show one block at a time, remembered under `key`. */
function chipFilter(blocks, key) {
  const chips = document.createElement('div');
  chips.className = 'product-group-filter';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Show');
  const choices = [ALL, ...blocks.map((b) => b.dataset?.group).filter(Boolean)];
  const show = (choice) => {
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.group === choice));
    for (const b of blocks) b.hidden = choice !== ALL && b.dataset?.group !== choice;
    chips.parentElement?.classList.toggle('is-filtered', choice !== ALL);
    remember(key, choice);
  };
  for (const choice of choices) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn filter-chip';
    chip.dataset.group = choice;
    chip.textContent = choice;
    chip.addEventListener('click', () => show(choice));
    chips.append(chip);
  }
  const saved = recall(key);
  // Run after the chips are in the page, so the "is-filtered" class lands on it.
  queueMicrotask(() => show(choices.includes(saved) ? saved : ALL));
  return chips;
}

/** Buttons with a name and a part count; a type without parts isn't a link. */
function grid(items) {
  const list = document.createElement('ul');
  list.className = 'product-type-grid';
  for (const { name, count, href } of items) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'product-type-name';
    label.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'product-type-count';
    badge.textContent = String(count);
    let box;
    if (count === 0) {
      // Shown so the list matches the sheet's tabs, but there's nothing to open.
      box = document.createElement('span');
      box.className = 'product-type is-empty';
      box.setAttribute('aria-label', `${name}: no parts yet`);
    } else {
      box = document.createElement('a');
      box.className = 'product-type';
      box.href = href;
      box.setAttribute('aria-label', `${name}: ${count} parts`);
    }
    box.append(label, badge);
    li.append(box);
    list.append(li);
  }
  return list;
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not saved; nothing else depends on it.
  }
}
