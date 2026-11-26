// Hash-based routing: #/  #/receiver  #/transmitter  #/category/<id>  #/part/<id>
//
// Why the hash: the part after # never goes to a server, so a static host
// needs no rewrite rules, reloads keep your place, and the browser's Back
// button and Safari's swipe-back gesture work for free.

export const DIAGRAMS = ['receiver', 'transmitter'];

/** Turn a location hash into a route object. Unknown hashes go home. */
export function parseHash(hash) {
  const path = (hash || '').replace(/^#\/?/, '');
  const [kind, rawId, ...rest] = path.split('/');
  if (kind === 'settings' && !rawId) return { name: 'settings' };
  // The home screen with a chosen diagram. Plain #/ shows the last one used.
  if (DIAGRAMS.includes(kind) && !rawId) return { name: 'home', diagram: kind };
  if (rest.length === 0 && rawId) {
    const id = decodeURIComponent(rawId);
    if (kind === 'category') return { name: 'category', id };
    if (kind === 'part') return { name: 'part', id };
  }
  return { name: 'home' };
}

/** Build a hash for a route. */
export function hrefFor(name, id) {
  if (name === 'home') return id ? `#/${id}` : '#/';
  if (name === 'settings') return '#/settings';
  return `#/${name}/${encodeURIComponent(id)}`;
}

/** Call onRoute now and on every hash change. */
export function startRouter(onRoute) {
  const handle = () => onRoute(parseHash(location.hash));
  window.addEventListener('hashchange', handle);
  handle();
}
