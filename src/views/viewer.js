// Datasheet viewer: one part's PDF, rendered in-app with PDF.js.

import { downloads, getSavedDatasheet } from '../offline/downloads.js';
import { DocumentView, ZOOM_LIMITS } from '../pdf/document-view.js';
import { attachPinch } from '../pdf/pinch.js';
import { loadPdfjs } from '../pdf/pdfjs.js';
import { hrefFor } from '../router.js';
import { downloadParts } from '../ui/download-actions.js';
import { button, el } from '../ui/dom.js';
import { showError } from '../ui/errors.js';

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

  const viewer = new Viewer(container, part);
  result.destroy = () => viewer.destroy();
  // Load in the background; the screen (title, back button) shows right away.
  viewer.open();
  return result;
}

class Viewer {
  constructor(container, part) {
    this.container = container;
    this.part = part;
    this.destroyed = false;
    this.cleanups = [];
  }

  async open() {
    const { datasheet } = this.part;
    if (!datasheet?.sha256) {
      this.showNoDatasheet();
      return;
    }
    this.showMessage('Opening datasheet…', '');
    try {
      // Always read from the datasheet cache on this device (CLAUDE.md),
      // never straight from the network. Same code online and offline.
      const [pdfjs, response] = await Promise.all([loadPdfjs(), getSavedDatasheet(this.part)]);
      if (this.destroyed) return;
      if (!response) {
        this.showNotDownloaded();
        return;
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (this.destroyed) return;

      this.loadingTask = pdfjs.getDocument({ data });
      const pdf = await this.loadingTask.promise;
      if (this.destroyed) return;
      await this.showDocument(pdf);
    } catch (error) {
      if (this.destroyed) return;
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
    frame.append(toolbar.element, scroller);
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
      attachPinch(scroller, {
        onChange: (scale, x, y) => this.doc.previewZoom(scale, x, y),
        onEnd: (scale, x, y) => this.doc.setZoom(this.doc.zoom * scale, x, y),
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

    element.append(info, group(prev, pageLabel, next), group(zoomOut, zoomLabel, zoomIn, fit));

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

  /** The datasheet exists but isn't on this device yet. */
  showNotDownloaded(problem = '') {
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
    this.container.replaceChildren(box);
  }

  /** The line card has no datasheet file for this part at all. */
  showNoDatasheet() {
    this.container.replaceChildren(
      el(
        'div',
        { class: 'message' },
        el('h2', {}, 'No datasheet in the app'),
        el('p', {}, `The ${this.part.mpn} datasheet hasn't been added to the line card yet.`),
        this.manufacturerLink(),
      ),
    );
  }

  manufacturerLink() {
    const source = this.part.datasheet?.sourceUrl;
    if (!source) return null;
    return el(
      'div',
      {},
      el(
        'a',
        { class: 'btn', href: source, target: '_blank', rel: 'noopener' },
        `Open on the ${this.part.manufacturer} website`,
      ),
      el('p', { class: 'message-note' }, 'Needs an internet connection.'),
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
