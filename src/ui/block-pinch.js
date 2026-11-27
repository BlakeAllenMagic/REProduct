// Stops pinch-to-zoom on an area (the parts tables): there, the A− / A+
// buttons are the only way to change the size.
//
// - Touch screens in most browsers: CSS `touch-action: pan-x pan-y` on the
//   area (table.css) lets one finger scroll but not two fingers zoom.
// - Safari (iPad touch, Mac trackpad) zooms through its own `gesture*`
//   events, which are cancelled here.
// - Ctrl + mouse wheel (desktop) is cancelled too.
//
// isEnabled() is checked each time: while the page itself is already zoomed
// in (pinched elsewhere first), pinches are left alone so it can zoom back out.
// Returns a function that removes the listeners.

export function blockPinch(element, isEnabled = () => true) {
  const stop = (event) => {
    if (isEnabled()) event.preventDefault();
  };
  const wheel = (event) => {
    if (event.ctrlKey) stop(event);
  };
  element.addEventListener('gesturestart', stop);
  element.addEventListener('gesturechange', stop);
  element.addEventListener('wheel', wheel, { passive: false });
  return () => {
    element.removeEventListener('gesturestart', stop);
    element.removeEventListener('gesturechange', stop);
    element.removeEventListener('wheel', wheel);
  };
}
