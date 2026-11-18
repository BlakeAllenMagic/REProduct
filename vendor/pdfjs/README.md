# PDF.js (vendored)

- Package: `pdfjs-dist` 6.5.438, **legacy build** (`legacy/build/`), which includes polyfills for older browsers.
- Files: `pdf.min.mjs` (main library) and `pdf.worker.min.mjs` (parses PDFs on a background thread).
- License: Apache 2.0, see `LICENSE`.

Why vendored: the app must work offline, so PDF.js ships inside the app shell instead of loading from a CDN.

Browser support: the PDF.js FAQ lists the legacy build as "Safari 18+: Mostly", which is why the app's baseline is iPadOS 18 / Safari 18. The modern build's FAQ entry has no Safari row at all, so stay on the legacy build.

Left out on purpose (add them if a real datasheet renders wrong):
- `standard_fonts/` (820 KB): for PDFs that use non-embedded standard fonts. The browser's own fonts are used instead.
- `cmaps/` (1.7 MB): for CJK text.
- `wasm/` (1.4 MB): for JPEG 2000 / JBIG2 images and ICC color.

To update: `npm pack pdfjs-dist@<version>` in a scratch folder, unpack it, and copy the two files and LICENSE from `package/legacy/build/` and `package/` into this folder.
