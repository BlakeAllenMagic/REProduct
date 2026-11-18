// Loads the vendored PDF.js on first use.
//
// PDF.js is about 1.8 MB, so it's loaded only when a datasheet is first
// opened; the diagram and tables don't wait for it. The worker parses PDFs
// on a background thread so scrolling stays smooth while a big file loads.

let loading;

export function loadPdfjs() {
  loading ??= import('../../vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    // `new URL(..., import.meta.url)` lets Vite find, copy and hash the
    // worker file at build time, so it's part of the app like any other file.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      '../../vendor/pdfjs/pdf.worker.min.mjs',
      import.meta.url,
    ).href;
    return pdfjs;
  });
  // If loading fails, allow a later attempt to try again.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
