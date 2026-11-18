import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const DEV_DATASHEETS = resolve(import.meta.dirname, 'dev-datasheets');
const HASHED_PDF = /^\/datasheets\/([0-9a-f]{64})\.pdf$/;

/**
 * Serve /datasheets/<sha256>.pdf from dev-datasheets/ during `vite` and
 * `vite preview`. In production the PDFs come from R2 (phase 4), so this
 * plugin never ends up in the built app.
 */
function devDatasheets() {
  const handler = (req, res, next) => {
    const match = HASHED_PDF.exec((req.url ?? '').split('?')[0]);
    if (!match) return next();
    const file = resolve(DEV_DATASHEETS, `${match[1]}.pdf`);
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', statSync(file).size);
    createReadStream(file).pipe(res);
  };
  return {
    name: 'dev-datasheets',
    // Braces matter: if these hooks return a function, Vite runs it as a
    // "post" hook, which is not what we want.
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  // Relative asset paths, so the built app works from any folder or host.
  base: './',
  plugins: [devDatasheets()],
  build: {
    target: 'safari17',
  },
});
