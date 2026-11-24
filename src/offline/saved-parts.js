// Remembers which datasheet version (hash) each part had when it was saved
// on this device: { partId: sha256 }.
//
// Why: when a manufacturer publishes a new version, linecard.json only lists
// the NEW hash. This record is how the app knows "this part's datasheet was
// saved here before, so download its new version", and how the viewer can
// still show the previous version until the new one is downloaded.
//
// Kept in localStorage: small, and lost only if the whole site's storage is
// cleared, in which case the saved PDFs are gone too.

const KEY = 'linecard.savedParts';

export function readSavedParts() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function write(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage blocked: updates fall back to "download what's missing".
  }
}

/** Record that these parts' datasheet is now the file with this hash. */
export function rememberSaved(partIds, sha) {
  if (!partIds?.length) return;
  const map = readSavedParts();
  for (const id of partIds) map[id] = sha;
  write(map);
}

/**
 * For devices that saved PDFs before this record existed: every part whose
 * current hash is already saved gets recorded. Never removes entries.
 */
export function backfillSavedParts(parts, savedHashes) {
  const map = readSavedParts();
  let changed = false;
  for (const part of parts) {
    const sha = part.datasheet?.sha256;
    if (sha && savedHashes.has(sha) && map[part.id] !== sha) {
      map[part.id] = sha;
      changed = true;
    }
  }
  if (changed) write(map);
  return map;
}
