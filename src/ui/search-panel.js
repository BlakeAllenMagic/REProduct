// The search panel: opens over the current screen from the top-bar button.
//
// It's a panel rather than a separate screen because on iPad the keyboard
// only appears if the text box is focused during the tap itself. open()
// runs inside the tap and focuses the box straight away.

import { getSavedHashes } from '../offline/downloads.js';
import { hrefFor } from '../router.js';
import { searchParts } from '../search.js';
import { button, el } from './dom.js';

export function installSearch(openButton, ctx) {
  let overlay = null;
  let input;
  let list;
  let saved = new Set();

  const close = () => {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    window.removeEventListener('hashchange', close);
    document.removeEventListener('keydown', onKey);
    openButton.focus({ preventScroll: true });
  };

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const render = () => {
    const query = input.value;
    const results = searchParts(ctx.linecard.parts, query);
    if (!query.trim()) {
      list.replaceChildren(el('li', { class: 'search-hint' }, 'Type a part number, manufacturer or description.'));
      return;
    }
    if (results.length === 0) {
      list.replaceChildren(el('li', { class: 'search-hint' }, `No parts match "${query.trim()}".`));
      return;
    }
    list.replaceChildren(
      ...results.map((part) => {
        const category = ctx.categories.get(part.category);
        const isSaved = part.datasheet?.sha256 && saved.has(part.datasheet.sha256);
        return el(
          'li',
          {},
          el(
            'a',
            { class: 'search-result', href: hrefFor('part', part.id) },
            el(
              'span',
              { class: 'search-result-top' },
              el('strong', {}, part.mpn),
              isSaved ? el('span', { class: 'search-saved' }, 'Saved') : null,
            ),
            el('span', { class: 'search-result-meta' }, `${part.manufacturer} · ${category?.name ?? ''}`),
            part.description ? el('span', { class: 'search-result-desc' }, part.description) : null,
          ),
        );
      }),
    );
  };

  const open = () => {
    if (overlay) {
      input.focus();
      return;
    }
    input = el('input', {
      type: 'search',
      class: 'search-input',
      placeholder: 'Part number, manufacturer or description',
      'aria-label': 'Search parts',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
    });
    list = el('ul', { class: 'search-results', 'aria-live': 'polite' });
    const panel = el(
      'div',
      { class: 'search-panel' },
      el('div', { class: 'search-bar' }, input, button('Close', close, { 'aria-label': 'Close search' })),
      list,
    );
    overlay = el('div', { class: 'search-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search parts' }, panel);
    // Tapping the dimmed area outside the panel closes it.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const first = list.querySelector('.search-result');
      if (first) location.hash = first.getAttribute('href');
    });
    document.body.append(overlay);
    // Focus now, inside the tap, so the iPad keyboard opens.
    input.focus();

    window.addEventListener('hashchange', close); // a result was opened
    document.addEventListener('keydown', onKey);
    render();
    getSavedHashes()
      .then((hashes) => {
        saved = hashes;
        if (overlay) render();
      })
      .catch(() => {}); // the "Saved" labels are a nice-to-have
  };

  openButton.addEventListener('click', open);
}
