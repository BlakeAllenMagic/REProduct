// The parts table's Filter panel: builds the controls for the filters that
// src/table-filter.js describes, and reports every change. The state object
// is kept by the table (per product type) and changed in place here.

import { specHeader } from '../format.js';
import { button, el } from './dom.js';

/** A box for a number: text input with the number keyboard (allows "1,5" too). */
function numberBox(label, value, onInput) {
  return el('input', {
    type: 'text',
    inputmode: 'decimal',
    enterkeyhint: 'done',
    autocomplete: 'off',
    class: 'filter-number',
    'aria-label': label,
    value: value ?? '',
    oninput: (event) => onInput(event.target.value),
  });
}

export function createFilterPanel({ filters, state, onChange }) {
  const rows = filters.map((filter) => {
    const label = filter.kind === 'range' ? `${filter.label} covers` : specHeader(filter.spec);
    const set = (value) => {
      state[filter.id] = value;
      onChange();
    };
    let control;
    switch (filter.kind) {
      case 'range': {
        const value = (state[filter.id] ??= {});
        control = el(
          'div',
          { class: 'filter-inline' },
          numberBox(`${label} (${filter.unit})`, value.from, (v) => set({ ...state[filter.id], from: v })),
          el('span', {}, 'to'),
          numberBox(`${label}, up to (${filter.unit}, optional)`, value.to, (v) => set({ ...state[filter.id], to: v })),
          el('span', { class: 'filter-unit' }, filter.unit),
        );
        break;
      }
      case 'number': {
        const value = (state[filter.id] ??= {});
        control = el(
          'div',
          { class: 'filter-inline' },
          el('span', {}, 'at least'),
          numberBox(`${label}, at least`, value.min, (v) => set({ ...state[filter.id], min: v })),
          el('span', {}, 'at most'),
          numberBox(`${label}, at most`, value.max, (v) => set({ ...state[filter.id], max: v })),
        );
        break;
      }
      case 'choice': {
        const chosen = new Set(state[filter.id] ?? []);
        control = el(
          'div',
          { class: 'filter-choices', role: 'group', 'aria-label': label },
          filter.options.map((option) => {
            const chip = button(option, () => {
              if (chosen.has(option)) chosen.delete(option);
              else chosen.add(option);
              chip.setAttribute('aria-pressed', String(chosen.has(option)));
              set([...chosen]);
            }, { class: 'btn filter-chip', 'aria-pressed': String(chosen.has(option)) });
            return chip;
          }),
        );
        break;
      }
      case 'contains':
        control = el('input', {
          type: 'search',
          enterkeyhint: 'done',
          autocomplete: 'off',
          class: 'filter-text',
          'aria-label': `${label} contains`,
          placeholder: 'contains…',
          value: state[filter.id] ?? '',
          oninput: (event) => set(event.target.value),
        });
        break;
      default:
        control = null;
    }
    return el('div', { class: 'filter-row' }, el('span', { class: 'filter-label' }, label), control);
  });

  const clear = button('Clear all', () => {
    for (const key of Object.keys(state)) delete state[key];
    onChange({ rebuild: true });
  });
  return el('section', { class: 'filter-panel', 'aria-label': 'Filters' }, rows, el('div', { class: 'filter-actions' }, clear));
}
