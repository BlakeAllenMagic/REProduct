// Sorting rules for the parts table. Pure functions, unit tested.
//
// A column is { key, type: 'number' | 'text', best: 'asc' | 'desc', value(part) }.
// "best" comes from the `sort` setting in categories.yaml (NF: asc, lower is
// better; gain: desc, higher is better). Columns without one use 'asc'.

/**
 * What one tap on a column header does:
 *   not sorted by it -> best first -> reversed -> back to normal order (null)
 */
export function nextSort(current, column) {
  if (!current || current.key !== column.key) return { key: column.key, dir: column.best };
  if (current.dir === column.best) return { key: column.key, dir: column.best === 'asc' ? 'desc' : 'asc' };
  return null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

/**
 * A sorted copy of parts. Parts with no value always go last, in either
 * direction. Equal values keep their original order (stable sort).
 */
export function sortParts(parts, column, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...parts].sort((a, b) => {
    const va = column.value(a);
    const vb = column.value(b);
    const ma = isMissing(va);
    const mb = isMissing(vb);
    if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
    if (column.type === 'number') return sign * (va - vb);
    // "Natural" text order: "0603" < "1008", "2x2 mm" < "10x10 mm".
    return sign * collator.compare(String(va), String(vb));
  });
}

/** Spec keys shown after every other column. */
export const LAST_SPECS = ['eccn'];

/** A spec column is shown only if at least this share of the parts fill it. */
export const MIN_FILLED_SHARE = 0.1;

/** Does at least MIN_FILLED_SHARE of `parts` have a value for this spec? */
export function isWorthShowing(spec, parts) {
  if (!parts) return true;
  const filled = parts.filter((p) => {
    const v = p.specs?.[spec.key];
    return v !== undefined && v !== null && v !== '';
  }).length;
  return filled > 0 && filled >= parts.length * MIN_FILLED_SHARE;
}

/**
 * The table's columns, in display order, for a category. Given the parts,
 * specs that fewer than 10% of them fill are left out of the table (the
 * part's page still lists them), so it adjusts as parts are added.
 */
export function columnsFor(category, parts) {
  const specColumn = (spec) => ({
    key: `spec:${spec.key}`,
    spec,
    type: spec.type,
    best: spec.sort ?? 'asc',
    value: (p) => p.specs[spec.key],
  });
  // ECCN (export classification) always comes last, after the description.
  const isLast = (spec) => LAST_SPECS.includes(spec.key);
  const specs = category.specs.filter((spec) => isWorthShowing(spec, parts));
  return [
    { key: 'mpn', label: 'Part number', type: 'text', best: 'asc', value: (p) => p.mpn },
    { key: 'manufacturer', label: 'Manufacturer', type: 'text', best: 'asc', value: (p) => p.manufacturer },
    ...specs.filter((spec) => !isLast(spec)).map(specColumn),
    { key: 'description', label: 'Description', type: 'text', best: 'asc', value: (p) => p.description },
    ...specs.filter(isLast).map(specColumn),
  ];
}
