// "★ 4" in the top bar while the shortlist has parts; it opens the Shortlist screen.

import { shortlist } from '../shortlist.js';

export function installShortlistChip(chip) {
  const update = () => {
    const n = shortlist.ids.length;
    chip.hidden = n === 0;
    chip.textContent = `★ ${n}`;
    chip.setAttribute('aria-label', `Shortlist: ${n} part${n === 1 ? '' : 's'}`);
  };
  shortlist.addEventListener('change', update);
  update();
}
