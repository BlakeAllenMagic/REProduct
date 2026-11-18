// Shows a PDF as a vertical stack of pages inside a scrolling box.
//
// Memory is the main constraint. iPad Safari caps the total memory all
// canvases can use; past it, canvases silently render blank. So:
//   - every page gets a placeholder box of the right size, but only pages
//     near the screen get a canvas (IntersectionObserver);
//   - canvases far from the screen are released (width/height set to 0,
//     which frees their memory right away in WebKit);
//   - each canvas is capped at MAX_CANVAS_PIXELS, so a heavy zoom gets a bit
//     softer instead of failing.
//
// Zoom is relative to "fit width": 1 means the widest page fills the box.

const PAGE_GAP = 12; // px between pages, and around the stack
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024; // well under iOS's 16.7 M per-canvas limit

export class DocumentView {
  /**
   * @param {object} options
   * @param {HTMLElement} options.scroller the scrolling box
   * @param {object} options.pdf PDFDocumentProxy from PDF.js
   * @param {(page: number, total: number) => void} options.onPageChange
   * @param {(zoom: number) => void} options.onZoomChange
   * @param {(error: unknown) => void} options.onError
   */
  constructor({ scroller, pdf, onPageChange, onZoomChange, onError }) {
    this.scroller = scroller;
    this.pdf = pdf;
    this.onPageChange = onPageChange;
    this.onZoomChange = onZoomChange;
    this.onError = onError;
    this.zoom = 1;
    this.layoutVersion = 0;
    this.currentPage = 0;
    this.slots = [];
    this.visible = new Set();
    this.destroyed = false;

    this.stack = document.createElement('div');
    this.stack.className = 'pdf-pages';
    this.stack.style.gap = `${PAGE_GAP}px`;
    this.stack.style.padding = `${PAGE_GAP}px`;
    scroller.append(this.stack);
  }

  get pageCount() {
    return this.pdf.numPages;
  }

  /** Read every page's size and build the placeholders. */
  async init() {
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const page = await this.pdf.getPage(n);
      if (this.destroyed) return;
      const { width, height } = page.getViewport({ scale: 1 });
      const box = document.createElement('div');
      box.className = 'pdf-page';
      box.dataset.page = String(n);
      box.setAttribute('aria-label', `Page ${n}`);
      this.stack.append(box);
      this.slots.push({ n, page, width, height, box, canvas: null, task: null, version: -1 });
    }
    this.maxPageWidth = Math.max(...this.slots.map((s) => s.width));
    this.layout();

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.scroller,
      rootMargin: '100% 0px', // pages within one screen above or below count as "near"
    });
    this.slots.forEach((slot) => this.observer.observe(slot.box));

    this.onScroll = () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.updateCurrentPage();
      });
    };
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });

    // Rotation or window resize: keep the same page in view at the new width.
    this.lastWidth = this.scroller.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.scroller.clientWidth;
      if (width === this.lastWidth || !width) return;
      this.lastWidth = width;
      const page = this.currentPage || 1;
      this.layout();
      this.goToPage(page);
    });
    this.resizeObserver.observe(this.scroller);

    this.updateCurrentPage();
  }

  /** CSS pixels per PDF point at the current zoom. */
  get scale() {
    const available = this.scroller.clientWidth - 2 * PAGE_GAP;
    const fit = Math.max(available, 100) / this.maxPageWidth;
    return fit * this.zoom;
  }

  /** Size every placeholder for the current zoom, then redraw nearby pages. */
  layout() {
    const scale = this.scale;
    this.layoutVersion++;
    for (const slot of this.slots) {
      slot.box.style.width = `${Math.round(slot.width * scale)}px`;
      slot.box.style.height = `${Math.round(slot.height * scale)}px`;
    }
    this.visible.forEach((slot) => this.render(slot));
  }

  onIntersect(entries) {
    for (const entry of entries) {
      const slot = this.slots[Number(entry.target.dataset.page) - 1];
      if (entry.isIntersecting) {
        this.visible.add(slot);
        this.render(slot);
      } else {
        this.visible.delete(slot);
        this.release(slot);
      }
    }
  }

  /**
   * Draw one page. The new canvas replaces the old one only once it's
   * finished, so zooming shows the old (stretched) page instead of a blank.
   */
  async render(slot) {
    if (slot.version === this.layoutVersion || this.destroyed) return;
    slot.task?.cancel();
    const version = this.layoutVersion;
    const cssWidth = slot.width * this.scale;
    const cssHeight = slot.height * this.scale;
    let ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    const pixels = cssWidth * cssHeight * ratio * ratio;
    if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(cssWidth * ratio);
    canvas.height = Math.floor(cssHeight * ratio);
    const viewport = slot.page.getViewport({ scale: this.scale * ratio });
    const task = slot.page.render({ canvas, viewport });
    slot.task = task;
    try {
      await task.promise;
    } catch (error) {
      freeCanvas(canvas);
      if (error?.name !== 'RenderingCancelledException') this.onError(error);
      return;
    }
    if (slot.task === task) slot.task = null;
    if (this.destroyed || version !== this.layoutVersion || !this.visible.has(slot)) {
      freeCanvas(canvas);
      return;
    }
    if (slot.canvas) freeCanvas(slot.canvas);
    slot.canvas = canvas;
    slot.version = version;
    slot.box.replaceChildren(canvas);
  }

  release(slot) {
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      freeCanvas(slot.canvas);
      slot.canvas = null;
    }
    slot.version = -1;
    slot.box.replaceChildren();
  }

  updateCurrentPage() {
    const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let current = 1;
    for (const slot of this.slots) {
      if (slot.box.offsetTop <= middle) current = slot.n;
      else break;
    }
    if (current !== this.currentPage) {
      this.currentPage = current;
      this.onPageChange(current, this.pageCount);
    }
  }

  goToPage(n) {
    const slot = this.slots[Math.min(Math.max(n, 1), this.pageCount) - 1];
    if (!slot) return;
    this.scroller.scrollTop = slot.box.offsetTop - PAGE_GAP;
    this.updateCurrentPage();
  }

  clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  /**
   * Live pinch feedback: stretch the existing pages with a CSS transform
   * (cheap, every frame) without redrawing anything.
   */
  previewZoom(factor, clientX, clientY) {
    const effective = this.clampZoom(this.zoom * factor) / this.zoom;
    const rect = this.scroller.getBoundingClientRect();
    const originX = this.scroller.scrollLeft + clientX - rect.left - this.stack.offsetLeft;
    const originY = this.scroller.scrollTop + clientY - rect.top - this.stack.offsetTop;
    this.stack.style.transformOrigin = `${originX}px ${originY}px`;
    this.stack.style.transform = `scale(${effective})`;
  }

  /**
   * Set the zoom and keep the point under (clientX, clientY) in place, so the
   * spot you pinched on stays under your fingers.
   */
  setZoom(zoom, clientX, clientY) {
    this.stack.style.transform = '';
    zoom = this.clampZoom(zoom);
    const rect = this.scroller.getBoundingClientRect();
    clientX ??= rect.left + rect.width / 2;
    clientY ??= rect.top + rect.height / 2;
    const ax = clientX - rect.left;
    const ay = clientY - rect.top;

    // Find where the anchor sits as a fraction of the page under it.
    const contentY = this.scroller.scrollTop + ay;
    const contentX = this.scroller.scrollLeft + ax;
    const slot =
      this.slots.find((s) => s.box.offsetTop + s.box.offsetHeight >= contentY) ??
      this.slots[this.slots.length - 1];
    const fx = (contentX - slot.box.offsetLeft) / slot.box.offsetWidth;
    const fy = (contentY - slot.box.offsetTop) / slot.box.offsetHeight;

    this.zoom = zoom;
    this.layout();

    this.scroller.scrollLeft = slot.box.offsetLeft + fx * slot.box.offsetWidth - ax;
    this.scroller.scrollTop = slot.box.offsetTop + fy * slot.box.offsetHeight - ay;
    this.updateCurrentPage();
    this.onZoomChange(this.zoom);
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.slots.forEach((slot) => this.release(slot));
    this.visible.clear();
  }
}

function freeCanvas(canvas) {
  // Shrinking to 0x0 frees the pixel memory immediately in WebKit, instead
  // of waiting for garbage collection.
  canvas.width = 0;
  canvas.height = 0;
}

export const ZOOM_LIMITS = { min: MIN_ZOOM, max: MAX_ZOOM };
