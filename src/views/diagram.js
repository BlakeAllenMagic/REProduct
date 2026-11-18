// Home screen: the receiver block diagram.
//
// The SVG is inserted inline (not as an <img>) so CSS can style it and each
// block can receive taps. For every block, categories.yaml (via linecard.json)
// decides which category it opens; blocks without parts are disabled.

import receiverSvg from '../diagram/receiver.svg?raw';
import { hrefFor } from '../router.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function renderDiagram(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'diagram';
  wrap.innerHTML = receiverSvg;
  container.append(wrap);

  const help = document.createElement('p');
  help.className = 'diagram-help';
  help.textContent = 'Tap a block to see the parts on the line card.';
  container.append(help);

  for (const block of wrap.querySelectorAll('[data-block]')) {
    setUpBlock(block, ctx);
  }

  return { title: 'RF Line Card' };
}

function setUpBlock(block, ctx) {
  const label = block.querySelector('.block-label')?.textContent ?? block.dataset.block;
  const category = ctx.categoryForBlock.get(block.dataset.block);
  const count = category ? ctx.partsByCategory.get(category.id).length : 0;

  if (!category || count === 0) {
    block.classList.add('is-disabled');
    block.setAttribute('aria-disabled', 'true');
    block.setAttribute('aria-label', `${label}: no parts on the line card`);
    return;
  }

  block.setAttribute('role', 'link');
  block.setAttribute('tabindex', '0');
  block.setAttribute('aria-label', `${label}: ${count} ${category.name}`);
  block.append(makeBadge(block, count));

  const open = () => {
    location.hash = hrefFor('category', category.id);
  };
  // `click` fires for mouse, trackpad and touch, so nothing depends on hover.
  block.addEventListener('click', open);
  block.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

/** A count bubble on the block's top-right corner. */
function makeBadge(block, count) {
  const rect = block.querySelector('.block-bg');
  const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) - 4;
  const y = Number(rect.getAttribute('y')) + 4;

  const badge = document.createElementNS(SVG_NS, 'g');
  badge.setAttribute('class', 'block-badge');
  badge.setAttribute('aria-hidden', 'true');

  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', x);
  circle.setAttribute('cy', y);
  circle.setAttribute('r', 16);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  text.textContent = String(count);

  badge.append(circle, text);
  return badge;
}
