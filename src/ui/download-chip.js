// A small "Downloading 3 / 11" chip in the top bar, so downloads are visible
// from every screen. Tapping it opens Settings.

import { downloads } from '../offline/downloads.js';

export function installDownloadChip(chip) {
  const update = (state) => {
    chip.hidden = !state.running;
    if (state.running) {
      chip.textContent = `Downloading ${state.done} / ${state.total}`;
      chip.setAttribute('aria-label', `Downloading datasheets: ${state.done} of ${state.total}`);
    }
  };
  downloads.addEventListener('progress', (event) => update(event.detail));
  downloads.addEventListener('finished', (event) => update(event.detail));
}
