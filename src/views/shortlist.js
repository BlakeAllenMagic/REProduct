// The Shortlist screen (#/shortlist): parts starred during a meeting, sent in
// one email with "Send all".
//
// The PDFs are read from the datasheet cache as soon as the screen opens, not
// when "Send all" is tapped: Safari only allows the share sheet right after a
// tap, and reading files first would use that up (see src/share/send.js).
// Parts whose datasheet isn't on this device go in the email as a link.

import { formatBytes } from '../format.js';
import { getSavedDatasheet } from '../offline/downloads.js';
import { hrefFor } from '../router.js';
import { shortlist } from '../shortlist.js';
import { canShareFiles, emailShortlistLinks, makeDatasheetFile, sendShortlist } from '../share/send.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

/** Above this, many mail servers refuse the email (Apple Mail offers Mail Drop). */
const LARGE_EMAIL = 20 * 1024 * 1024;

export function renderShortlist(container, ctx) {
  const screen = new ShortlistScreen(container, ctx);
  return {
    title: 'Shortlist',
    back: { href: hrefFor('home'), label: 'Diagram' },
    destroy: () => screen.destroy(),
  };
}

class ShortlistScreen {
  constructor(container, ctx) {
    this.ctx = ctx;
    this.files = new Map(); // part id -> File, for parts whose PDF is on this device
    this.reading = true;
    this.sent = false; // after a successful "Send all": offer to clear
    this.root = el('div', { class: 'shortlist' });
    container.append(this.root);
    this.onChange = () => {
      this.sent = false;
      this.render();
    };
    shortlist.addEventListener('change', this.onChange);
    this.render();
    this.readFiles();
  }

  destroy() {
    this.destroyed = true;
    shortlist.removeEventListener('change', this.onChange);
  }

  async readFiles() {
    try {
      for (const part of shortlist.parts(this.ctx)) {
        if (!part.datasheet?.sha256 || this.files.has(part.id)) continue;
        const response = await getSavedDatasheet(part);
        if (this.destroyed) return;
        if (response) this.files.set(part.id, makeDatasheetFile(part, await response.blob()));
      }
    } catch (error) {
      showError(error, "Couldn't read the saved datasheets");
    }
    if (this.destroyed) return;
    this.reading = false;
    this.render();
  }

  /** [{ part, file }] for the listed parts whose PDF is ready. */
  attachments(parts) {
    return parts.filter((p) => this.files.has(p.id)).map((part) => ({ part, file: this.files.get(part.id) }));
  }

  render() {
    const parts = shortlist.parts(this.ctx);
    if (parts.length === 0) {
      this.root.replaceChildren(
        el(
          'div',
          { class: 'message' },
          el('h2', {}, 'No parts on the shortlist'),
          el('p', {}, 'Tap the ☆ next to a part number in a table, or on a part’s page. Then send all their datasheets in one email from here.'),
        ),
      );
      return;
    }
    const attached = this.attachments(parts);
    const bytes = attached.reduce((sum, a) => sum + a.file.size, 0);
    const shareable = canShareFiles(attached.map((a) => a.file));

    const summary = this.reading
      ? `${parts.length} part${parts.length === 1 ? '' : 's'} · reading the saved datasheets…`
      : `${parts.length} part${parts.length === 1 ? '' : 's'} · ${attached.length} datasheet${attached.length === 1 ? '' : 's'} attached (${formatBytes(bytes)})` +
        (attached.length < parts.length ? `, ${parts.length - attached.length} as a link` : '');

    const send = button('Send all', () => this.send(parts, attached), {
      primary: true,
      disabled: this.reading || attached.length === 0 || !shareable,
    });
    const links = button('Email links', () => emailShortlistLinks(parts));
    const clear = button('Clear list', () => shortlist.clear());

    const notes = [];
    if (!this.reading && bytes > LARGE_EMAIL) {
      notes.push(el('p', { class: 'shortlist-warning' }, `That's a large email (${formatBytes(bytes)}). Many mail servers refuse over about 20 MB; Apple Mail offers Mail Drop for big attachments. Or remove a few parts.`));
    }
    if (!this.reading && attached.length > 0 && !shareable) {
      notes.push(el('p', { class: 'message-note' }, 'This browser can’t attach files. “Email links” sends every part as a link instead.'));
    }
    if (this.sent) {
      notes.push(
        el(
          'div',
          { class: 'shortlist-sent', role: 'status' },
          el('span', {}, 'Sent. Clear the shortlist?'),
          button('Clear list', () => shortlist.clear(), { primary: true }),
          button('Keep', () => {
            this.sent = false;
            this.render();
          }),
        ),
      );
    }

    this.root.replaceChildren(
      el('p', { class: 'shortlist-summary', 'aria-live': 'polite' }, summary),
      el('div', { class: 'shortlist-actions' }, send, links, clear),
      ...notes,
      el('ul', { class: 'shortlist-list' }, parts.map((part) => this.row(part))),
    );
  }

  row(part) {
    let status;
    if (this.files.has(part.id)) status = 'Datasheet attached';
    else if (part.datasheet?.sha256) status = this.reading ? 'Reading…' : 'Not saved on this device: sent as a link';
    else status = 'No datasheet in the app: sent as a link';
    return el(
      'li',
      { class: 'shortlist-item' },
      el(
        'div',
        { class: 'shortlist-text' },
        el('a', { class: 'shortlist-mpn', href: hrefFor('part', part.id) }, part.mpn),
        el('span', { class: 'shortlist-maker' }, part.manufacturer),
        part.description ? el('span', { class: 'shortlist-desc' }, part.description) : null,
        el('span', { class: 'shortlist-status' }, status),
      ),
      button('Remove', () => shortlist.remove(part.id), { 'aria-label': `Remove ${part.mpn} from the shortlist` }),
    );
  }

  send(parts, attached) {
    // No await before sendShortlist(): it must run inside the tap.
    sendShortlist(parts, attached).then(
      (result) => {
        if (this.destroyed || result !== 'shared') return;
        this.sent = true;
        this.render();
      },
      (error) => {
        const message =
          error?.name === 'NotAllowedError'
            ? 'The browser blocked the share sheet. Tap "Send all" again, or use "Email links".'
            : `${error instanceof Error ? error.message : String(error)}. You can use "Email links" instead.`;
        showError(new Error(message), "Couldn't send the shortlist");
      },
    );
  }
}
