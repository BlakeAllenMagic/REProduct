// Starting downloads from a button: check there's room first, then go.

import { downloads, getSavedHashes, itemsForParts } from '../offline/downloads.js';
import { checkSpace } from '../offline/storage.js';
import { formatBytes } from '../format.js';
import { showError } from './errors.js';

/**
 * Download the datasheets for these parts that aren't on the device yet.
 * Warns first if the device reports too little free space.
 * Returns the run's promise, or null if the user said no.
 */
export async function downloadParts(parts) {
  const items = itemsForParts(parts);
  try {
    const saved = await getSavedHashes();
    const missing = new Map(items.filter((i) => !saved.has(i.sha)).map((i) => [i.sha, i]));
    const bytes = [...missing.values()].reduce((sum, i) => sum + (i.bytes ?? 0), 0);

    const space = await checkSpace(bytes);
    if (space.enough === false) {
      const ok = window.confirm(
        `These datasheets need about ${formatBytes(bytes)}, but the browser reports only ` +
          `${formatBytes(space.available)} free. Download anyway? Files that don't fit will be ` +
          `listed as errors, and nothing already saved is lost.`,
      );
      if (!ok) return null;
    }
    return downloads.download(items);
  } catch (error) {
    showError(error, `Couldn't start the download`);
    return null;
  }
}
