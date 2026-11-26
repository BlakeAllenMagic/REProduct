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

/** The table's columns, in display order, for a category. */
export function columnsFor(category) {
  const specColumn = (spec) => ({
    key: `spec:${spec.key}`,
    spec,
    type: spec.type,
    best: spec.sort ?? 'asc',
    value: (p) => p.specs[spec.key],
  });
  // ECCN (export classification) always comes last, after the description.
  const isLast = (spec) => LAST_SPECS.includes(spec.key);
  return [
    { key: 'mpn', label: 'Part number', type: 'text', best: 'asc', value: (p) => p.mpn },
    { key: 'manufacturer', label: 'Manufacturer', type: 'text', best: 'asc', value: (p) => p.manufacturer },
    ...category.specs.filter((spec) => !isLast(spec)).map(specColumn),
    { key: 'description', label: 'Description', type: 'text', best: 'asc', value: (p) => p.description },
    ...category.specs.filter(isLast).map(specColumn),
  ];
}
