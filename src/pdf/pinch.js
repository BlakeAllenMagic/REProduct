// Turns pinch gestures into zoom callbacks.
//
// Browsers report pinches in three different ways:
//   - Safari (iPad touch and Mac trackpad): non-standard `gesture*` events
//     with a ready-made `scale` value.
//   - Chrome, Firefox, Edge on a trackpad: `wheel` events with ctrlKey set.
//   - Touch screens elsewhere (later: Android, Windows): two Pointer Events.
//
// onChange(scale, clientX, clientY) fires during the pinch (scale is relative
// to the start), onEnd(scale, clientX, clientY) once at the end.
// Optional isEnabled(): checked when a pinch starts; if it returns false the
// pinch is left to the browser (no preventDefault), e.g. to zoom the page out.
// Returns a function that removes all listeners.

export function attachPinch(element, { onChange, onEnd, isEnabled = () => true }) {
  const removers = [];
  const on = (type, handler, options) => {
    element.addEventListener(type, handler, options);
    removers.push(() => element.removeEventListener(type, handler, options));
  };

  let gestureActive = false;

  if ('ongesturestart' in window) {
    let anchor = { x: 0, y: 0 };
    let scale = 1;
    on('gesturestart', (event) => {
      if (!isEnabled()) return; // let Safari zoom the page
      event.preventDefault(); // stop Safari zooming the whole page
      gestureActive = true;
      scale = 1;
      anchor = centerOf(element, event);
    });
    on('gesturechange', (event) => {
      if (!gestureActive) return;
      event.preventDefault();
      scale = event.scale;
      onChange(scale, anchor.x, anchor.y);
    });
    on('gestureend', (event) => {
      if (!gestureActive) return;
      event.preventDefault();
      gestureActive = false;
      onEnd(scale, anchor.x, anchor.y);
    });
  } else {
    const pointers = new Map();
    let start = null;
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const midpoint = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    on('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2 && isEnabled()) {
        gestureActive = true;
        start = { distance: distance(), ...midpoint(), scale: 1 };
      }
    });
    on('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (start && pointers.size === 2) {
        start.scale = distance() / start.distance;
        onChange(start.scale, start.x, start.y);
      }
    });
    const lift = (event) => {
      if (!pointers.delete(event.pointerId)) return;
      if (start && pointers.size < 2) {
        gestureActive = false;
        onEnd(start.scale, start.x, start.y);
        start = null;
      }
    };
    on('pointerup', lift);
    on('pointercancel', lift);
  }

  // Trackpad pinch in non-Safari browsers (and Ctrl + mouse wheel).
  let wheel = null;
  on(
    'wheel',
    (event) => {
      if (!event.ctrlKey || gestureActive) return;
      if (!wheel && !isEnabled()) return;
      event.preventDefault(); // otherwise the browser zooms the whole page
      wheel ??= { scale: 1, x: event.clientX, y: event.clientY, timer: 0 };
      wheel.scale *= Math.exp(-event.deltaY / 100);
      onChange(wheel.scale, wheel.x, wheel.y);
      clearTimeout(wheel.timer);
      wheel.timer = setTimeout(() => {
        const { scale, x, y } = wheel;
        wheel = null;
        onEnd(scale, x, y);
      }, 150);
    },
    { passive: false },
  );

  return () => {
    if (wheel) clearTimeout(wheel.timer);
    removers.forEach((remove) => remove());
  };
}

function centerOf(element, event) {
  // Safari's GestureEvent normally has the pinch center in clientX/clientY.
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
