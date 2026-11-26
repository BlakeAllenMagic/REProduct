// Lookups over linecard.json, built once when the data loads.

/**
 * @param {object} linecard parsed linecard.json
 * @returns {{
 *   linecard: object,
 *   categories: Map<string, object>,
 *   parts: Map<string, object>,
 *   partsByCategory: Map<string, object[]>,
 *   categoryForBlock: Map<string, object>,
 *   manufacturerSites: Map<string, string>,
 * }}
 */
export function indexLinecard(linecard) {
  if (!linecard || !Array.isArray(linecard.categories) || !Array.isArray(linecard.parts)) {
    throw new Error('linecard.json is missing "categories" or "parts"');
  }

  const categories = new Map();
  const partsByCategory = new Map();
  const categoryForBlock = new Map();
  for (const category of linecard.categories) {
    categories.set(category.id, category);
    partsByCategory.set(category.id, []);
    // categories.yaml decides which diagram blocks open which category.
    for (const block of category.blocks ?? []) {
      categoryForBlock.set(block, category);
    }
  }

  const parts = new Map();
  for (const part of linecard.parts) {
    parts.set(part.id, part);
    partsByCategory.get(part.category)?.push(part);
  }

  return {
    linecard,
    categories,
    parts,
    partsByCategory,
    categoryForBlock,
    manufacturerSites: manufacturerSites(linecard.parts),
  };
}

/**
 * Links to a part on the manufacturer's site (CLAUDE.md: the datasheet link
 * is optional; a product page may be given instead, or as well).
 *   linkForPage:  for "Open on the website": the product page first
 *   linkForEmail: for emails: the direct PDF first, it's what the customer wants
 */
export function linkForPage(part) {
  return part.productUrl || part.datasheet?.sourceUrl || null;
}

export function linkForEmail(part) {
  return part.datasheet?.sourceUrl || part.productUrl || null;
}

/**
 * Manufacturer -> its website's host name, learned from the product page
 * links of its other parts ("Marki Microwave" -> "markimicrowave.com").
 * Distributor links (datasheet links) aren't used: they'd point at Mouser.
 */
export function manufacturerSites(parts) {
  const sites = new Map();
  for (const part of parts) {
    if (sites.has(part.manufacturer) || !part.productUrl) continue;
    try {
      sites.set(part.manufacturer, new URL(part.productUrl).hostname.replace(/^www\./, ''));
    } catch {
      // Not a valid link; another part may have one.
    }
  }
  return sites;
}

/**
 * For a part with no link of its own: a web search for its part number on
 * the manufacturer's site (or the whole web, if the site isn't known).
 */
export function searchLinkFor(part, sites) {
  const site = sites?.get(part.manufacturer);
  const query = site ? `site:${site} ${part.mpn}` : `${part.manufacturer} ${part.mpn} datasheet`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
