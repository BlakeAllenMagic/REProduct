// Smooth screen changes: going deeper (diagram -> table -> datasheet) slides
// the new screen in from the right; going back slides it in from the left;
// switching between screens at the same level (Receiver <-> Transmitter)
// cross-fades. Only the content moves; the top bar stays put (base.css).
//
// Uses the browser's View Transitions (Safari 18, Chrome). Where they're
// missing, or Reduce Motion is on, screens change instantly as before.

const DEPTH = { home: 0, category: 1, shortlist: 1, settings: 1, part: 2 };

/** 'forward', 'back' or 'fade' for a move between two routes. */
export function directionFor(from, to) {
  const a = DEPTH[from?.name] ?? 0;
  const b = DEPTH[to?.name] ?? 0;
  if (b > a) return 'forward';
  if (b < a) return 'back';
  return 'fade';
}

/**
 * Run `update` (which swaps the screen) inside a view transition when one
 * makes sense. Resolves when the new screen is in place.
 */
export function withTransition(from, to, update) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!from || reduce || typeof document.startViewTransition !== 'function' || document.hidden) {
    return Promise.resolve(update());
  }
  const root = document.documentElement;
  root.dataset.nav = directionFor(from, to);
  const transition = document.startViewTransition(update);
  transition.finished.finally(() => {
    if (root.dataset.nav) delete root.dataset.nav;
  });
  return transition.updateCallbackDone;
}
