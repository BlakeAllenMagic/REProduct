// Keeps the top bar readable at any width: if the title, "‹ Back" and the
// buttons don't fit, their text gets smaller (17 px down to 11 px) instead of
// overlapping or being cut off with "…". If that isn't enough, the title
// moves off-centre, and as a last resort it gets its own line under the
// back label and buttons.
//
// It reruns whenever the bar's contents change (new screen, "Send datasheet"
// appearing, a download chip) or the window is resized or rotated.

const MAX_PX = 17;
const MIN_PX = 11;

export function installTopbarFit(topbar) {
  const back = topbar.querySelector('.topbar-back');
  const title = topbar.querySelector('.topbar-title');
  const actions = topbar.querySelector('.topbar-actions');

  const measure = () => {
    const style = getComputedStyle(topbar);
    return {
      inner: topbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      gap: parseFloat(style.columnGap) || 0,
      back: back.hidden ? 0 : back.scrollWidth,
      title: title.scrollWidth,
      actions: actions.scrollWidth,
    };
  };
  // Centred title: it needs the wider side's room on both sides.
  const fitsCentred = () => {
    const m = measure();
    return m.title + 2 * Math.max(m.back, m.actions) + 2 * m.gap <= m.inner + 0.5;
  };
  // Title off-centre: everything just has to fit side by side.
  const fitsSideBySide = () => {
    const m = measure();
    return m.back + m.title + m.actions + 2 * m.gap <= m.inner + 0.5;
  };
  const shrinkUntil = (fits) => {
    for (let size = MAX_PX; size >= MIN_PX; size -= 1) {
      topbar.style.setProperty('--topbar-font', `${size}px`);
      if (fits()) return true;
    }
    return false;
  };

  // Title on its own line: it has to fit the full width, and back + buttons
  // the first line.
  const fitsStacked = () => {
    const m = measure();
    return m.title <= m.inner + 0.5 && m.back + m.actions + m.gap <= m.inner + 0.5;
  };

  // Steps, until something fits: smaller text with the title centred; then
  // the title off-centre; then the title on its own line under the back
  // label and buttons (topbar-wrap), as big as fits there.
  const fit = () => {
    topbar.classList.remove('topbar-tight', 'topbar-wrap');
    if (!shrinkUntil(fitsCentred)) {
      topbar.classList.add('topbar-tight');
      if (!shrinkUntil(fitsSideBySide)) {
        topbar.classList.add('topbar-wrap');
        shrinkUntil(fitsStacked); // at 11 px whatever is left wraps between words
      }
    }
    // The bar's real height, for screens laid out under it (the PDF viewer).
    document.documentElement.style.setProperty('--topbar-actual', `${topbar.getBoundingClientRect().height}px`);
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit();
    });
  };

  // Only changes to the bar's contents. The class changes fit() itself makes
  // on the bar are ignored: reacting to them would rerun fit() every frame.
  new MutationObserver((records) => {
    if (records.some((r) => !(r.target === topbar && r.attributeName === 'class'))) schedule();
  }).observe(topbar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'disabled'],
  });
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
  return fit; // for tests and for calling right after a render
}
