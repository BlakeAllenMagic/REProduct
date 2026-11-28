// Datasheet viewer: one part's PDF, rendered in-app with PDF.js.

import { starButton, watchStars } from '../ui/star-button.js';
import { linkForEmail, linkForPage, searchLinkFor } from '../data.js';
import { downloads, getSavedDatasheet, getSavedFile } from '../offline/downloads.js';
import { readSavedParts } from '../offline/saved-parts.js';
import { DocumentView, ZOOM_LIMITS } from '../pdf/document-view.js';
import { attachPinch } from '../pdf/pinch.js';
import { loadPdfjs } from '../pdf/pdfjs.js';
import { hrefFor } from '../router.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';
import { keySpecs, specList } from '../ui/spec-list.js';
import { isPageZoomed, watchPageZoom } from '../ui/page-zoom.js';
import { canShareFile, describeShareError, emailLink, makeDatasheetFile, sendDatasheet } from '../share/send.js';

const ZOOM_STEP = 1.25;

export function renderViewer(container, ctx, route) {
  const part = ctx.parts.get(route.id);
  if (!part) {
    container.innerHTML = `<div class="message"><h2>Part not found</h2>
      <p>This link points to a part that isn't on the line card.</p></div>`;
    return { title: 'Not found', back: { href: hrefFor('home'), label: 'Diagram' } };
  }
  const category = ctx.categories.get(part.category);
  const result = {
    title: part.mpn,
    back: { href: hrefFor('category', part.category), label: category?.name ?? 'Back' },
  };

  const viewer = new Viewer(container, part, ctx.manufacturerSites, category);
  // ☆ adds the part to the shortlist (src/shortlist.js), next to the send buttons.
  const star = starButton(part, 'star-in-topbar');
  const stopWatchingStars = watchStars(document.getElementById('actions') ?? document.body);
  result.actions = [star, ...viewer.sendButtons()];
  result.destroy = () => {
    stopWatchingStars();
    viewer.destroy();
  };
  // Load in the background; the screen (title, back button) shows right away.
  viewer.open();
  return result;
}

class Viewer {
  constructor(container, part, sites, category) {
    this.container = container;
    this.part = part;
    this.sites = sites;
    this.category = category;
    this.destroyed = false;
    this.cleanups = [];
  }

  async open() {
    const { datasheet } = this.part;
    if (!datasheet?.sha256) {
      this.showNoDatasheet();
      return;
    }
    this.unavailable = false;
    this.updateSendButtons();
    this.showMessage('Opening datasheet…', '');
    try {
      // Always read from the datasheet cache on this device (CLAUDE.md),
      // never straight from the network. Same code online and offline.
      let [pdfjs, response] = await Promise.all([loadPdfjs(), getSavedDatasheet(this.part)]);
      if (this.destroyed) return;
      // The newest version isn't here yet, but an older one is: show that
      // (an update never leaves a part with nothing to show).
      this.previousVersion = false;
      const older = readSavedParts()[this.part.id];
      if (!response && older && older !== datasheet.sha256) {
        response = await getSavedFile(older);
        this.previousVersion = Boolean(response);
      }
      if (this.destroyed) return;
      if (!response) {
        this.showNotDownloaded();
        return;
      }
      // Keep the PDF as a File, ready for "Send datasheet" (see src/share/send.js).
      // Built from the Blob before PDF.js gets the bytes: PDF.js moves the
      // buffer it's given into its worker, which leaves the original empty.
      const blob = await response.blob();
      this.file = makeDatasheetFile(this.part, blob);
      this.updateSendButtons();
      const data = new Uint8Array(await blob.arrayBuffer());
      if (this.destroyed) return;

      this.loadingTask = pdfjs.getDocument({ data });
      const pdf = await this.loadingTask.promise;
      if (this.destroyed) return;
      await this.showDocument(pdf);
    } catch (error) {
      if (this.destroyed) return;
      this.unavailable = !this.file;
      this.updateSendButtons();
      showError(error, `Couldn't open the ${this.part.mpn} datasheet`);
      this.showMessage(`Couldn't open the datasheet`, describe(error), true);
    }
  }

  async showDocument(pdf) {
    const toolbar = this.buildToolbar();
    const scroller = document.createElement('div');
    scroller.className = 'pdf-scroll';
    scroller.tabIndex = 0; // arrow keys and Page Up/Down scroll it on a Mac
    scroller.setAttribute('aria-label', `${this.part.mpn} datasheet`);

    const frame = document.createElement('div');
    frame.className = 'viewer';
    if (this.previousVersion) {
      frame.append(
        el(
          'p',
          { class: 'viewer-note', role: 'note' },
          'Showing the previous version of this datasheet. The new version downloads automatically when online.',
        ),
      );
    }
    this.specsPanel = el('div', { class: 'viewer-specs', hidden: true }, specList(this.part, this.category));
    frame.append(...[toolbar.element, this.keySpecsStrip(), this.specsPanel, scroller].filter(Boolean));
    this.container.replaceChildren(frame);

    this.doc = new DocumentView({
      scroller,
      pdf,
      onPageChange: (page, total) => toolbar.setPage(page, total),
      onZoomChange: (zoom) => toolbar.setZoom(zoom),
      onError: (error) => showError(error, 'Page failed to draw'),
    });
    await this.doc.init();
    if (this.destroyed) return;
    toolbar.setZoom(this.doc.zoom);
    scroller.focus({ preventScroll: true });

    this.cleanups.push(
      // While the page itself is zoomed in, pinches zoom the page (back out).
      watchPageZoom(scroller),
      attachPinch(scroller, {
        onChange: (scale, x, y) => this.doc.previewZoom(scale, x, y),
        onEnd: (scale, x, y) => this.doc.setZoom(this.doc.zoom * scale, x, y),
        isEnabled: () => !isPageZoomed(),
      }),
    );
  }

  buildToolbar() {
    const element = document.createElement('div');
    element.className = 'viewer-toolbar';

    const info = document.createElement('div');
    info.className = 'viewer-info';
    info.textContent = [this.part.manufacturer, this.part.description].filter(Boolean).join(' · ');

    const button = (label, aria, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      return b;
    };
    const group = (...children) => {
      const g = document.createElement('div');
      g.className = 'viewer-group';
      g.append(...children);
      return g;
    };

    const prev = button('‹', 'Previous page', () => this.doc?.goToPage(this.doc.currentPage - 1));
    const next = button('›', 'Next page', () => this.doc?.goToPage(this.doc.currentPage + 1));
    const pageLabel = document.createElement('span');
    pageLabel.className = 'viewer-label';
    pageLabel.setAttribute('aria-live', 'polite');

    const zoomOut = button('−', 'Zoom out', () => this.doc?.setZoom(this.doc.zoom / ZOOM_STEP));
    const zoomIn = button('+', 'Zoom in', () => this.doc?.setZoom(this.doc.zoom * ZOOM_STEP));
    const fit = button('Fit', 'Fit page width', () => this.doc?.setZoom(1));
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'viewer-label';
    // Hidden on phones, where pinching zooms (src/styles/viewer.css).
    for (const b of [zoomOut, zoomLabel, zoomIn]) b.classList.add('zoom-step');

    // "Specs" opens the part's values above the PDF (closed by default).
    const specsButton = button('Specs', 'Specs', () => this.toggleSpecs(specsButton));
    this.specsToggle = specsButton;
    specsButton.setAttribute('aria-expanded', 'false');

    element.append(info, specsButton, group(prev, pageLabel, next), group(zoomOut, zoomLabel, zoomIn, fit));

    return {
      element,
      setPage(page, total) {
        pageLabel.textContent = `${page} / ${total}`;
        prev.disabled = page <= 1;
        next.disabled = page >= total;
      },
      setZoom(zoom) {
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        zoomOut.disabled = zoom <= ZOOM_LIMITS.min + 1e-6;
        zoomIn.disabled = zoom >= ZOOM_LIMITS.max - 1e-6;
        fit.disabled = Math.abs(zoom - 1) < 1e-6;
      },
    };
  }

  /**
   * Top-bar buttons:
   * - "Send datasheet": shares the PDF itself, once it's loaded and the
   *   browser can share files.
   * - "Email link": a prefilled email with the manufacturer's link. Useful
   *   for big files, and the fallback when the PDF can't be attached.
   */
  sendButtons() {
    const hasLink = Boolean(linkForEmail(this.part));
    this.sendButton = button('Send datasheet', () => this.send(), {
      primary: true,
      disabled: true,
      hidden: true,
    });
    this.linkButton = button('Email link', () => emailLink(this.part), { hidden: !hasLink });
    this.updateSendButtons();
    return [this.linkButton, this.sendButton];
  }

  updateSendButtons() {
    if (!this.sendButton) return;
    const hasFile = Boolean(this.part.datasheet?.sha256);
    const ready = canShareFile(this.file);
    // Show "Send datasheet" for any part with a file; enable it once the PDF
    // is loaded. If this browser can't share files at all, hide it and leave
    // "Email link".
    this.sendButton.hidden = !hasFile || this.unavailable || (this.file && !ready);
    this.sendButton.disabled = !ready;
  }

  send() {
    // No await before sendDatasheet(): it must run inside the tap.
    sendDatasheet(this.part, this.file).catch((error) => {
      showError(new Error(describeShareError(error)), `Couldn't send the ${this.part.mpn} datasheet`);
    });
  }

  /** The specs, shown under the "no datasheet" messages. */
  specsSection() {
    return el('section', { class: 'message spec-section' }, el('h3', {}, 'Specs'), specList(this.part, this.category));
  }

  /**
   * The part's headline numbers as chips above the datasheet ("0.3–10.6 GHz",
   * "IL 0.4 dB"...), so they're readable at a glance over the rep's shoulder.
   * One row that scrolls sideways; a tap opens the full Specs list (or, on
   * the "not downloaded" screens, scrolls to it).
   */
  keySpecsStrip(onTap = () => this.toggleSpecs(this.specsToggle)) {
    const chips = keySpecs(this.part, this.category);
    if (chips.length === 0) return null;
    const strip = el(
      'div',
      { class: 'key-specs', 'aria-label': `Key specs: ${chips.map((c) => c.text).join(', ')}` },
      chips.map((c) => el('span', { class: 'key-spec' }, c.text)),
    );
    strip.addEventListener('click', onTap);
    return strip;
  }

  toggleSpecs(toggle) {
    const open = this.specsPanel.hidden;
    this.specsPanel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-on', open);
  }

  /** The datasheet exists but isn't on this device yet. */
  showNotDownloaded(problem = '') {
    this.unavailable = true;
    this.updateSendButtons();
    const online = navigator.onLine;
    const box = el(
      'div',
      { class: 'message' },
      el('h2', {}, 'Not downloaded'),
      el('p', {}, `The ${this.part.mpn} datasheet isn't on this device yet.`),
      problem ? el('p', { class: 'error-text' }, problem) : null,
    );
    if (online) {
      box.append(button('Download now', () => this.downloadThis(), { primary: true }));
    } else {
      box.append(el('p', { class: 'message-note' }, 'Connect to the internet to download it.'));
      box.append(this.manufacturerLink());
    }
    this.container.replaceChildren(...[this.messageStrip(), box, this.specsSection()].filter(Boolean));
  }

  /** The key-spec strip for the screens without a PDF: a tap scrolls to the Specs list. */
  messageStrip() {
    return this.keySpecsStrip(() => this.container.querySelector('.spec-section')?.scrollIntoView({ behavior: 'smooth' }));
  }

  /** The line card has no datasheet file for this part at all. */
  showNoDatasheet() {
    this.container.replaceChildren(
      ...[this.messageStrip()].filter(Boolean),
      el(
        'div',
        { class: 'message' },
        el('h2', {}, 'No datasheet in the app'),
        el('p', {}, `The ${this.part.mpn} datasheet hasn't been added to the line card yet.`),
        this.manufacturerLink(),
      ),
      this.specsSection(),
    );
  }

  manufacturerLink() {
    // No link of its own (e.g. Marki's connectorized parts): search the
    // manufacturer's site for the part number instead.
    const source = linkForPage(this.part);
    const href = source ?? searchLinkFor(this.part, this.sites);
    const label = source
      ? `Open on the ${this.part.manufacturer} website`
      : `Find it on the ${this.part.manufacturer} website`;
    const note = source ? 'Needs an internet connection.' : 'Opens a web search. Needs an internet connection.';
    return el(
      'div',
      {},
      el('a', { class: 'btn', href, target: '_blank', rel: 'noopener' }, label),
      el('p', { class: 'message-note' }, note),
    );
  }

  /** Download just this datasheet, then open it. */
  downloadThis() {
    const sha = this.part.datasheet.sha256;
    this.showMessage('Downloading datasheet…', '');
    const onSaved = (event) => {
      if (event.detail.sha !== sha) return;
      stop();
      if (!this.destroyed) this.open();
    };
    const onFinished = (event) => {
      stop();
      if (this.destroyed) return;
      const failure = event.detail.failed.find((f) => f.sha === sha);
      if (failure) this.showNotDownloaded(`Download failed: ${failure.error}`);
      else this.open(); // already saved, or saved by the run
    };
    const stop = () => {
      downloads.removeEventListener('saved', onSaved);
      downloads.removeEventListener('finished', onFinished);
    };
    downloads.addEventListener('saved', onSaved);
    downloads.addEventListener('finished', onFinished);
    this.cleanups.push(stop);
    downloadParts([this.part]).then((run) => {
      if (run === null) stop(); // the user declined the space warning
    });
  }

  showMessage(title, detail, withRetry = false) {
    const box = document.createElement('div');
    box.className = 'message';
    const heading = document.createElement('h2');
    heading.textContent = title;
    box.append(heading);
    if (detail) {
      const text = document.createElement('p');
      text.textContent = detail;
      box.append(text);
    }
    if (withRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-primary';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => this.open());
      box.append(retry);
    }
    this.container.replaceChildren(box);
  }

  destroy() {
    this.destroyed = true;
    this.cleanups.forEach((cleanup) => cleanup());
    this.doc?.destroy();
    // Stops the worker's work on this file and frees its memory.
    this.loadingTask?.destroy();
  }
}

function describe(error) {
  if (error?.name === 'InvalidPDFException') return 'The file is damaged or is not a PDF.';
  if (error instanceof TypeError) return 'The file could not be fetched. Check the connection.';
  return error instanceof Error ? error.message : String(error);
}
