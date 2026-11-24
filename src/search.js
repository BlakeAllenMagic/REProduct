// Part search: matching and ranking. Pure functions, unit tested.
//
// Part numbers are written many ways ("ALM-1234", "ALM1234", "alm 1234"), so
// matching ignores capitals and the separators people skip when typing:
// dashes, spaces, dots, slashes and underscores.

const MAX_RESULTS = 50;

/** "ALM-1234" -> "alm1234" */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\-./_]+/g, '');
}

/**
 * Parts matching the query, best first:
 *   0. part number starts with the query
 *   1. part number contains it
 *   2. manufacturer or description contains it
 * Ties keep the line card's order (manufacturer, then part number).
 */
export function searchParts(parts, query, limit = MAX_RESULTS) {
  const q = normalize(query);
  if (!q) return [];
  const ranked = [];
  parts.forEach((part, index) => {
    const mpn = normalize(part.mpn);
    let rank = -1;
    if (mpn.startsWith(q)) rank = 0;
    else if (mpn.includes(q)) rank = 1;
    else if (normalize(part.manufacturer).includes(q) || normalize(part.description).includes(q)) rank = 2;
    if (rank >= 0) ranked.push({ part, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, limit).map((r) => r.part);
}
