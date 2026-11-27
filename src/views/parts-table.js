// Parts table for one category: every line card part with its key specs,
// plus whether its datasheet is on this device.

import { specHeader, specValue, MISSING } from '../format.js';
import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { isRecentlyUpdated } from '../offline/update-plan.js';
import { attachPinch } from '../pdf/pinch.js';
import { hrefFor } from '../router.js';
import { activeCount, filtersFor, matches } from '../table-filter.js';
import { columnsFor, nextSort, sortParts } from '../table-sort.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { createFilterPanel } from '../ui/filter-panel.js';
import { showError } from '../ui/errors.js';
import { isPageZoomed, watchPageZoom } from '../ui/page-zoom.js';
import { applyTextSize, readTextSize, setTextSize, TEXT_SIZE } from '../ui/text-size.js';

// Sort order per category, kept while the app is open, so opening a
// datasheet and coming back keeps the table as it was.
const sortByCategory = new Map(); // category id -> { key, dir }
// Filters per category, kept the same way (reset when the app is closed).
const filterByCategory = new Map(); // category id -> { state, open }

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
  const columns = columnsFor(category, parts);
  const rows = new Map(); // part id -> <tr>
  const headers = new Map(); // column key -> { th, arrow }
  const tbody = makeBody(columns, parts, statusCells, rows);

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
  const count = el('p', { class: 'table-count', 'aria-live': 'polite' });
  const downloadButton = button('Download this category', () => downloadParts(parts));
  const sizer = textSizeControls(table);

  // ---- Filters ----
  const filters = filtersFor(columns, parts);
  if (!filterByCategory.has(category.id)) filterByCategory.set(category.id, { state: {}, open: false });
  const saved = filterByCategory.get(category.id);
  const noMatch = el('p', { class: 'filter-empty', hidden: true }, 'No parts match these filters.');
  const filterButton = button('Filter', () => togglePanel(), {
    'aria-expanded': 'false',
    'aria-controls': 'filter-panel',
    hidden: filters.length === 0,
  });
  const panelSlot = el('div', { id: 'filter-panel', hidden: true });
  const applyFilters = () => {
    let shown = 0;
    for (const part of parts) {
      const visible = matches(part, filters, saved.state);
      rows.get(part.id).hidden = !visible;
      if (visible) shown += 1;
    }
    const on = activeCount(filters, saved.state);
    const noun = `part${parts.length === 1 ? '' : 's'}`;
    count.textContent = on ? `${shown} of ${parts.length} ${noun}` : `${parts.length} ${noun}`;
    filterButton.textContent = on ? `Filter (${on})` : 'Filter';
    filterButton.classList.toggle('is-on', on > 0);
    noMatch.hidden = shown > 0;
  };
  const buildPanel = () => {
    panelSlot.replaceChildren(
      createFilterPanel({
        filters,
        state: saved.state,
        onChange: (how) => {
          if (how?.rebuild) buildPanel(); // "Clear all": fresh, empty controls
          applyFilters();
        },
      }),
    );
  };
  const togglePanel = (open = !saved.open) => {
    saved.open = open;
    panelSlot.hidden = !open;
    filterButton.setAttribute('aria-expanded', String(open));
    if (open && !panelSlot.firstChild) buildPanel();
  };
  togglePanel(saved.open);
  applyFilters();

  const toolbar = el('div', { class: 'table-toolbar' }, count, filterButton, sizer.element, downloadButton);
  const scroller = el('div', { class: 'table-scroll' }, table);
  container.append(toolbar, panelSlot, noMatch, scroller);
  // If the page itself is zoomed in (e.g. pinched on the diagram before
  // opening this table), pinches go to the browser so it can zoom back out;
  // only at normal page zoom do they resize the table text.
  const stopWatchingZoom = watchPageZoom(scroller);
  const detachPinch = attachPinch(scroller, { ...sizer.pinch, isEnabled: () => !isPageZoomed() });

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
      detachPinch();
      stopWatchingZoom();
      for (const type of ['saved', 'finished', 'progress']) downloads.removeEventListener(type, update);
    },
  };
}

/**
 * A− / 100% / A+ buttons, and the pinch handlers, for the table text size.
 * During a pinch the table is only scaled with a transform (cheap, smooth);
 * on release the real size is set and the table re-lays out.
 */
function textSizeControls(table) {
  let size = readTextSize();
  applyTextSize(size);
  const value = button('', () => commit(TEXT_SIZE.default), {
    class: 'btn text-size-value',
    'aria-label': 'Reset table text size',
  });
  const smaller = button('A−', () => commit(size - TEXT_SIZE.step), { 'aria-label': 'Smaller table text' });
  const bigger = button('A+', () => commit(size + TEXT_SIZE.step), { 'aria-label': 'Bigger table text' });
  const show = () => {
    value.textContent = `${Math.round(size * 100)}%`;
    smaller.disabled = size <= TEXT_SIZE.min;
    bigger.disabled = size >= TEXT_SIZE.max;
  };
  const commit = (next) => {
    table.classList.remove('is-pinching');
    table.style.transform = '';
    table.style.transformOrigin = '';
    size = setTextSize(next);
    show();
  };
  show();

  // Where the fingers are when a pinch starts: the row under them and the
  // point's position in the table, so the table can grow around that point.
  let anchor = null;
  const startPinch = (x, y) => {
    const box = table.getBoundingClientRect();
    const row = document.elementFromPoint(x, y)?.closest('tr');
    anchor = {
      x,
      y,
      tableX: x - box.left, // includes how far the table is scrolled sideways
      tableWidth: box.width,
      row: row && table.contains(row) ? row : null,
      rowTop: row ? row.getBoundingClientRect().top : 0,
      rowHeight: row ? row.getBoundingClientRect().height : 1,
    };
    table.style.transformOrigin = `${x - box.left}px ${y - box.top}px`;
  };
  // After the real size is set: scroll so the same spot is under the fingers
  // again (sideways inside the table box, up/down on the page).
  const keepAnchorInPlace = () => {
    if (!anchor) return;
    const scroller = table.parentElement;
    const box = table.getBoundingClientRect();
    const newX = anchor.tableX * (box.width / anchor.tableWidth);
    scroller.scrollLeft += box.left + newX - anchor.x;
    if (anchor.row?.isConnected) {
      const rowBox = anchor.row.getBoundingClientRect();
      const offset = (anchor.y - anchor.rowTop) * (rowBox.height / anchor.rowHeight);
      window.scrollBy(0, rowBox.top + offset - anchor.y);
    }
    anchor = null;
  };

  return {
    element: el('div', { class: 'text-size', role: 'group', 'aria-label': 'Table text size' }, smaller, value, bigger),
    pinch: {
      onChange(scale, x, y) {
        if (!anchor) startPinch(x, y);
        const preview = Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, size * scale)) / size;
        table.classList.add('is-pinching');
        table.style.transform = `scale(${preview})`;
      },
      onEnd(scale) {
        if (!anchor) return commit(size * scale);
        // Measure without the preview stretch, then apply the real size.
        commit(size * scale);
        keepAnchorInPlace();
      },
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

function makeBody(columns, parts, statusCells, rows) {
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
    // The rest follow the heading order from columnsFor() (specs, description, then ECCN).
    for (const column of columns) {
      if (column.spec) {
        const { spec } = column;
        addCell(row, specValue(spec, part.specs[spec.key]), spec.type === 'number' ? 'num' : '');
      } else if (column.key === 'description') {
        addCell(row, part.description || MISSING, 'desc');
      }
    }

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
