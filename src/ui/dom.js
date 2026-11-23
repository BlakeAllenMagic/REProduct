// el('p', { class: 'note' }, 'Hello ', el('b', {}, 'there'))
// A tiny helper for building DOM. Text is always set as text, never as
// HTML, so data from CSVs can't inject markup.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function button(label, onClick, { primary = false, disabled = false, ...attrs } = {}) {
  return el(
    'button',
    { type: 'button', class: primary ? 'btn btn-primary' : 'btn', disabled, onclick: onClick, ...attrs },
    label,
  );
}
