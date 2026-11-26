// Parts table for one category: every line card part with its key specs,
// plus whether its datasheet is on this device.

import { specHeader, specValue, MISSING } from '../format.js';
import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { isRecentlyUpdated } from '../offline/update-plan.js';
import { hrefFor } from '../router.js';
import { columnsFor, nextSort, sortParts } from '../table-sort.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

// Sort order per category, kept while the app is open, so opening a
// datasheet and coming back keeps the table as it was.
const sortByCategory = new Map(); // category id -> { key, dir }

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
  const columns = columnsFor(category);
  const rows = new Map(); // part id -> <tr>
  const headers = new Map(); // column key -> { th, arrow }
  const tbody = makeBody(category, parts, statusCells, rows);

  // Put the rows in the current sort order and mark the sorted header.
  const applySort = () => {
    const state = sortByCategory.get(category.id) ?? null;
    const column = state && columns.find((c) => c.key === state.key);
    const ordered = column ? sortParts(parts, column, state.dir) : parts;
    for (const part of ordered) tbody.append(rows.get(part.id)); // moves the existing row
    for (const [key, { th, arrow }] of headers) {
      const active = column?.key === key;
      th.setAttribute('aria-sort', active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.classList.toggle('is-sorted', active);
      arrow.textContent = active ? (state.dir === 'asc' ? '▲' : '▼') : '';
    }
  };
  const onSort = (column) => {
    const next = nextSort(sortByCategory.get(category.id), column);
    if (next) sortByCategory.set(category.id, next);
    else sortByCategory.delete(category.id);
    applySort();
  };

  const table = el('table', { class: 'parts-table' }, makeHead(columns, headers, onSort), tbody);
  applySort();
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
        items.length === 0
          ? 'No datasheets to download'
          : missing === 0
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

function makeHead(columns, headers, onSort) {
  const thead = document.createElement('thead');
  const row = thead.insertRow();
  // Specs come right after the part number, so they're visible without
  // scrolling sideways; the long description goes last. Every column but
  // "Datasheet" sorts when its header is tapped.
  const sortable = (column) => {
    const label = column.spec ? specHeader(column.spec) : column.label;
    const arrow = el('span', { class: 'sort-arrow', 'aria-hidden': 'true' });
    const th = el(
      'th',
      { scope: 'col', class: `sortable${column.type === 'number' ? ' num' : ''}`, 'aria-sort': 'none' },
      el('button', { type: 'button', class: 'sort-button', title: `Sort by ${label}`, onclick: () => onSort(column) }, label, arrow),
    );
    headers.set(column.key, { th, arrow });
    return th;
  };
  const [mpn, ...rest] = columns;
  row.append(sortable(mpn), el('th', { scope: 'col' }, 'Datasheet'), ...rest.map(sortable));
  return thead;
}

function makeBody(category, parts, statusCells, rows) {
  const tbody = document.createElement('tbody');
  for (const part of parts) {
    const href = hrefFor('part', part.id);
    const row = tbody.insertRow();
    row.className = 'part-row';
    rows.set(part.id, row);

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
