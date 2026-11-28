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

// Specs that describe the part's make-up rather than its performance: left
// out of the key-spec chips (they're in the full Specs list).
const NOT_KEY = new Set(['family', 'package', 'case', 'notes', 'note', 'eccn', 'cross_ref', 'screening', 'qml', 'space', 'radiation', 'grade', 'status', 'flange', 'waveguide_band']);
const RANGE = /^(.*)_min_([a-z]+)$/;
// Text specs whose value reads well alone ("SPDT reflective", "50Ω", "GaN").
const SELF_EXPLAINING = new Set(['configuration', 'kind', 'topology', 'technology', 'impedance']);

/**
 * The part's headline numbers as short chips for the top of its page:
 * "0.3–10.6 GHz", "IL 0.4 dB", "SPDT reflective". In table-column order; a
 * Min / Max pair becomes one range; short text values are kept, long ones
 * and make-up specs (package, ECCN...) are left to the full list.
 */
export function keySpecs(part, category, max = 6) {
  const specs = category?.specs ?? [];
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const has = (key) => {
    const v = part.specs?.[key];
    return v !== undefined && v !== null && v !== '';
  };
  const chips = [];
  const used = new Set();
  for (const spec of specs) {
    if (chips.length >= max) break;
    if (used.has(spec.key) || NOT_KEY.has(spec.key) || !has(spec.key)) continue;
    const range = spec.key.match(RANGE);
    const maxKey = range && `${range[1]}_max_${range[2]}`;
    if (range && byKey.has(maxKey) && has(maxKey)) {
      used.add(maxKey);
      const lo = specValue(spec, part.specs[spec.key]);
      const hi = specValue(byKey.get(maxKey), part.specs[maxKey]);
      const name = spec.label.replace(/\s*min$/i, '');
      chips.push({ label: name, text: `${lo === hi ? lo : `${lo}–${hi}`}${spec.unit ? ` ${spec.unit}` : ''}` });
      continue;
    }
    const value = specValue(spec, part.specs[spec.key]);
    if (spec.type === 'number') {
      chips.push({ label: spec.label, text: `${spec.label} ${value}${spec.unit ? ` ${spec.unit}` : ''}` });
    } else {
      const text = SELF_EXPLAINING.has(spec.key) ? value : `${spec.label} ${value}`;
      if (text.length <= 32) chips.push({ label: spec.label, text });
    }
  }
  return chips;
}
