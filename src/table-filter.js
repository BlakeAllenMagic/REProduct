// Filters for the parts table (the Filter panel). No screen code here, so
// it's unit tested in tests/table-filter.test.js.
//
// filtersFor() looks at the table's columns and the parts, and describes one
// filter per column:
//   range    a min/max pair (Freq Min + Freq Max...): "covers 10 GHz", or
//            "covers 10 to 18 GHz"
//   number   at least / at most
//   choice   tap one or more of a few values (Family, Package...): "any of"
//   contains free text, for text columns with many different values
// The filter state is a plain object: { [filter id]: value }.

const MAX_CHOICES = 12;
const MAX_CHOICE_LENGTH = 30;
const FREE_TEXT = new Set(['notes', 'note']);

const hasValue = (v) => v !== undefined && v !== null && v !== '';

/** Describe the filters for these table columns. Frequency ranges come first. */
export function filtersFor(columns, parts) {
  const specs = columns.filter((c) => c.spec).map((c) => c.spec);
  const keys = new Set(specs.map((s) => s.key));
  const ranges = [];
  const others = [];
  const inRange = new Set();

  for (const spec of specs) {
    const match = spec.key.match(/^(.*)_min_ghz$/);
    if (!match) continue;
    const maxKey = `${match[1]}_max_ghz`;
    if (!keys.has(maxKey)) continue;
    inRange.add(spec.key).add(maxKey);
    ranges.push({
      id: `range:${match[1]}`,
      kind: 'range',
      label: spec.label.replace(/\s*Min$/, ''), // "Freq Min" -> "Freq"
      minKey: spec.key,
      maxKey,
    });
  }

  for (const spec of specs) {
    if (inRange.has(spec.key)) continue;
    if (spec.type === 'number') {
      others.push({ id: `number:${spec.key}`, kind: 'number', spec });
      continue;
    }
    const values = [...new Set(parts.map((p) => p.specs?.[spec.key]).filter(hasValue).map(String))];
    if (values.length === 0) continue;
    const short = values.length <= MAX_CHOICES && values.every((v) => v.length <= MAX_CHOICE_LENGTH);
    if (short && !FREE_TEXT.has(spec.key)) {
      if (values.length < 2) continue; // nothing to choose between (e.g. every ECCN is EAR99)
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      others.push({ id: `choice:${spec.key}`, kind: 'choice', spec, options: values.sort(collator.compare) });
    } else {
      others.push({ id: `contains:${spec.key}`, kind: 'contains', spec });
    }
  }
  return [...ranges, ...others];
}

/** A typed number, or null if the box is empty or not a number. */
export function parseNumber(text) {
  if (text === undefined || text === null) return null;
  const cleaned = String(text).trim().replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Is this filter set to something? */
export function isActive(filter, value) {
  if (!value) return false;
  switch (filter.kind) {
    case 'range':
      return parseNumber(value.from) !== null || parseNumber(value.to) !== null;
    case 'number':
      return parseNumber(value.min) !== null || parseNumber(value.max) !== null;
    case 'choice':
      return value.length > 0;
    case 'contains':
      return String(value).trim() !== '';
    default:
      return false;
  }
}

export function activeCount(filters, state) {
  return filters.filter((f) => isActive(f, state[f.id])).length;
}

/** Does one part pass one filter? */
function passes(part, filter, value) {
  if (!isActive(filter, value)) return true;
  const specs = part.specs ?? {};
  switch (filter.kind) {
    case 'range': {
      const low = specs[filter.minKey];
      // No upper edge (e.g. a highpass filter's pass band) means "and up".
      const high = hasValue(specs[filter.maxKey]) ? specs[filter.maxKey] : Infinity;
      if (!hasValue(low)) return false;
      const from = parseNumber(value.from);
      const to = parseNumber(value.to);
      const a = from ?? to;
      const b = to ?? from;
      return low <= Math.min(a, b) && high >= Math.max(a, b);
    }
    case 'number': {
      const v = specs[filter.spec.key];
      if (typeof v !== 'number') return false; // no value: can't show it meets the limit
      const min = parseNumber(value.min);
      const max = parseNumber(value.max);
      return (min === null || v >= min) && (max === null || v <= max);
    }
    case 'choice':
      return value.includes(String(specs[filter.spec.key] ?? ''));
    case 'contains':
      return String(specs[filter.spec.key] ?? '').toLowerCase().includes(String(value).trim().toLowerCase());
    default:
      return true;
  }
}

/** Does a part pass every filter that's set? */
export function matches(part, filters, state) {
  return filters.every((f) => passes(part, f, state[f.id]));
}
