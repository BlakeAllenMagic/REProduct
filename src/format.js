// Display helpers for spec values.

export const MISSING = '–';

/** Header text for a spec column: "NF (dB)" or "Package". */
export function specHeader(spec) {
  return spec.unit ? `${spec.label} (${spec.unit})` : spec.label;
}

/** Cell text for a spec value. Units live in the header, so cells are bare. */
export function specValue(spec, value) {
  if (value === undefined || value === null || value === '') return MISSING;
  if (spec.type === 'number' && typeof value === 'number') {
    // Up to 3 decimals, no trailing zeros: 0.6 -> "0.6", 1.565 -> "1.565", 18 -> "18".
    return String(Number(value.toFixed(3)));
  }
  return String(value);
}

/** "2.4 MB" style sizes, used for datasheet info. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return MISSING;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
