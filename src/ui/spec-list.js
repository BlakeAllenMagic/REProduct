// "Specs": every value a part has, as a label / value list. Shown on the
// part's page, so specs hidden from the table (too few parts use them) are
// still one tap away.

import { specHeader, specValue } from '../format.js';
import { el } from './dom.js';

/** [label, value] pairs for a part: maker and description first, then every non-empty spec. */
export function specRows(part, category) {
  const rows = [['Manufacturer', part.manufacturer]];
  if (part.description) rows.push(['Description', part.description]);
  for (const spec of category?.specs ?? []) {
    const value = part.specs?.[spec.key];
    if (value === undefined || value === null || value === '') continue;
    rows.push([specHeader(spec), specValue(spec, value)]);
  }
  return rows;
}

export function specList(part, category) {
  return el(
    'dl',
    { class: 'spec-list', 'aria-label': `${part.mpn} specs` },
    specRows(part, category).flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]),
  );
}
