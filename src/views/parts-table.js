// Parts table for one category: every line card part with its key specs.

import { specHeader, specValue, MISSING } from '../format.js';
import { hrefFor } from '../router.js';

export function renderPartsTable(container, ctx, route) {
  const category = ctx.categories.get(route.id);
  const back = { href: hrefFor('home'), label: 'Diagram' };
  if (!category) {
    container.innerHTML = `<div class="message"><h2>Category not found</h2>
      <p>This link points to a category that isn't on the line card.</p></div>`;
    return { title: 'Not found', back };
  }

  const parts = ctx.partsByCategory.get(category.id);
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';

  const table = document.createElement('table');
  table.className = 'parts-table';
  table.append(makeHead(category), makeBody(category, parts));
  scroller.append(table);

  const count = document.createElement('p');
  count.className = 'table-count';
  count.textContent = `${parts.length} part${parts.length === 1 ? '' : 's'}`;

  container.append(count, scroller);
  return { title: category.name, back };
}

function makeHead(category) {
  const thead = document.createElement('thead');
  const row = thead.insertRow();
  // Specs come right after the part number, so they're visible without
  // scrolling sideways; the long description goes last.
  const columns = [
    ['Part number', ''],
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

function makeBody(category, parts) {
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
    row.append(mpnCell);

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

function addCell(row, text, className = '') {
  const cell = row.insertCell();
  cell.textContent = text;
  if (className) cell.className = className;
}
