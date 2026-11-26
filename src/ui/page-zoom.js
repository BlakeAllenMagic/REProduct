// Is the browser's own page zoom active (the user pinched the page, e.g. on
// the diagram)? The table and the PDF viewer take over two-finger pinches for
// their own zoom; while the page is zoomed in they hand pinches back to the
// browser, so it can zoom back out. visualViewport.scale is standard (Safari 13+).

export function isPageZoomed() {
  return (window.visualViewport?.scale ?? 1) > 1.01;
}

/**
 * Keep `element` marked with the class "page-zoomed" while the page is zoomed
 * in (CSS then allows page pinch-zoom there). Returns a function that stops watching.
 */
export function watchPageZoom(element) {
  const viewport = window.visualViewport;
  const update = () => element.classList.toggle('page-zoomed', isPageZoomed());
  update();
  viewport?.addEventListener('resize', update);
  return () => viewport?.removeEventListener('resize', update);
}
