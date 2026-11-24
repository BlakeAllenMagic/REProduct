// Parts table for one category: every line card part with its key specs,
// plus whether its datasheet is on this device.

import { specHeader, specValue, MISSING } from '../format.js';
import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { isRecentlyUpdated } from '../offline/update-plan.js';
import { hrefFor } from '../router.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

export function renderPartsTable(container, ctx, route) {
  const category = ctx.categories.get(route.id);
  const back = { href: hrefFor('home'), label: 'Diagram' };
  if (!category) {
    container.innerHTML = `<div class="message"><h2>Category not found</h2>
      <p>This link points to a category that isn't on the line card.</p></div>`;
    return { title: 'Not found', back };
  }

  const parts = ctx.partsByCategory.get(category.id);
  const statusCells = new Map(); // sha -> [cell, ...]
  const table = el('table', { class: 'parts-table' }, makeHead(category), makeBody(category, parts, statusCells));
  const count = el('p', { class: 'table-count' }, `${parts.length} part${parts.length === 1 ? '' : 's'}`);
  const downloadButton = button('Download this category', () => downloadParts(parts));
  const toolbar = el('div', { class: 'table-toolbar' }, count, downloadButton);
  container.append(toolbar, el('div', { class: 'table-scroll' }, table));

  const items = itemsForParts(parts);
  let destroyed = false;
  const update = async () => {
    try {
      const saved = await getSavedHashes();
      if (destroyed) return;
      for (const [sha, cells] of statusCells) {
        for (const cell of cells) setStatus(cell, saved.has(sha) ? 'saved' : 'missing');
      }
      const missing = new Set(items.filter((i) => !saved.has(i.sha)).map((i) => i.sha)).size;
      downloadButton.disabled = missing === 0;
      downloadButton.textContent =
        missing === 0
          ? 'All datasheets saved'
          : downloads.running
            ? `Downloading… (${missing} left)`
            : `Download this category (${missing})`;
    } catch (error) {
      showError(error, `Couldn't check which datasheets are saved`);
    }
  };
  update();
  for (const type of ['saved', 'finished', 'progress']) downloads.addEventListener(type, update);

  return {
    title: category.name,
    back,
    destroy() {
      destroyed = true;
      for (const type of ['saved', 'finished', 'progress']) downloads.removeEventListener(type, update);
    },
  };
}

function makeHead(category) {
  const thead = document.createElement('thead');
  const row = thead.insertRow();
  // Specs come right after the part number, so they're visible without
  // scrolling sideways; the long description goes last.
  const columns = [
    ['Part number', ''],
    ['Datasheet', ''],
    ['Manufacturer', ''],
    ...category.specs.map((spec) => [specHeader(spec), spec.type === 'number' ? 'num' : '']),
    ['Description', ''],
  ];
  for (const [text, className] of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = text;
    if (className) th.className = className;
    row.append(th);
  }
  return thead;
}

function makeBody(category, parts, statusCells) {
  const tbody = document.createElement('tbody');
  for (const part of parts) {
    const href = hrefFor('part', part.id);
    const row = tbody.insertRow();
    row.className = 'part-row';

    // The part number is a real link (keyboard and screen readers); the
    // whole row is also tappable, because a 44 pt row is the natural target.
    const mpnCell = document.createElement('th');
    mpnCell.scope = 'row';
    const link = document.createElement('a');
    link.href = href;
    link.textContent = part.mpn;
    mpnCell.append(link);
    if (isRecentlyUpdated(part)) {
      mpnCell.append(
        el('span', { class: 'badge-updated', title: `Datasheet updated ${part.datasheet.updated}` }, 'Updated'),
      );
    }
    row.append(mpnCell);

    const status = addCell(row, '', 'status');
    const sha = part.datasheet?.sha256;
    if (sha) {
      if (!statusCells.has(sha)) statusCells.set(sha, []);
      statusCells.get(sha).push(status);
      setStatus(status, 'checking');
    } else {
      setStatus(status, 'none');
    }

    addCell(row, part.manufacturer);
    for (const spec of category.specs) {
      addCell(row, specValue(spec, part.specs[spec.key]), spec.type === 'number' ? 'num' : '');
    }
    addCell(row, part.description || MISSING, 'desc');

    row.addEventListener('click', (event) => {
      if (event.target.closest('a')) return; // the link handles itself
      location.hash = href;
    });
  }
  return tbody;
}

const STATUS = {
  checking: ['…', ''],
  saved: ['Saved', 'is-saved'],
  missing: ['Not saved', 'is-missing'],
  none: [MISSING, 'is-none'],
};

function setStatus(cell, status) {
  const [text, className] = STATUS[status];
  cell.textContent = text;
  cell.className = `status ${className}`.trim();
}

function addCell(row, text, className = '') {
  const cell = row.insertCell();
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}
