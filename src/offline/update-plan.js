// Decides what an update should download and what it may delete.
// Pure functions (no browser APIs), so they're unit tested in Node.
//
// Inputs:
//   parts        linecard.json's parts (each with datasheet.sha256)
//   saved        Set of hashes saved on this device
//   savedParts   { partId: sha } from saved-parts.js: which version of each
//                part's datasheet this device has had
//   keepEverything  true once this device has had every datasheet

/**
 * What to download:
 * - a part whose datasheet this device had before (any version) but whose
 *   CURRENT version isn't saved: that's a changed datasheet;
 * - in "keep everything" mode, any datasheet that isn't saved (new parts).
 * A device that never downloaded a part's datasheet doesn't get it pushed
 * by an update; the rep chose not to download it.
 */
export function partsToUpdate(parts, saved, savedParts, keepEverything) {
  return parts.filter((part) => {
    const sha = part.datasheet?.sha256;
    if (!sha || saved.has(sha)) return false;
    return keepEverything || part.id in savedParts;
  });
}

/**
 * Saved files that can be deleted: hashes no current part uses, EXCEPT an
 * old version still needed because its part's new version isn't saved yet.
 * That way an update that fails or hasn't run yet never leaves a part with
 * nothing to show (CLAUDE.md: never lose downloaded data).
 */
export function filesToDelete(parts, saved, savedParts) {
  const current = new Set(parts.map((p) => p.datasheet?.sha256).filter(Boolean));
  const stillNeeded = new Set();
  for (const part of parts) {
    const old = savedParts[part.id];
    const sha = part.datasheet?.sha256;
    if (old && old !== sha && !(sha && saved.has(sha))) stillNeeded.add(old);
  }
  return [...saved].filter((sha) => !current.has(sha) && !stillNeeded.has(sha));
}

/** True if every datasheet in the line card is saved. */
export function hasEverything(parts, saved) {
  return parts.every((part) => !part.datasheet?.sha256 || saved.has(part.datasheet.sha256));
}

/**
 * Parts whose datasheet was replaced by a new version in the last `days`
 * days ("Updated" badge). `changed` is set by the datasheet sync only when a
 * part's file changes, so a part whose datasheet was just added for the
 * first time gets no badge.
 */
export function isRecentlyUpdated(part, now = new Date(), days = 30) {
  const changed = part.datasheet?.sha256 && part.datasheet?.changed;
  if (!changed) return false;
  const age = now.getTime() - new Date(`${changed}T00:00:00Z`).getTime();
  return age >= 0 && age <= days * 24 * 60 * 60 * 1000;
}
