// Lookups over linecard.json, built once when the data loads.

/**
 * @param {object} linecard parsed linecard.json
 * @returns {{
 *   linecard: object,
 *   categories: Map<string, object>,
 *   parts: Map<string, object>,
 *   partsByCategory: Map<string, object[]>,
 *   categoryForBlock: Map<string, object>,
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

  return { linecard, categories, parts, partsByCategory, categoryForBlock };
}
