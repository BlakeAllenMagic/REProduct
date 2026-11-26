import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { serviceWorker } from './tools/vite-sw-plugin.js';

/**
 * Tests: serve (and build) another linecard.json instead of public/'s, so the
 * automated tests use the sample parts in tests/fixtures/ whatever the real
 * parts list holds. Set LINECARD_FILE=tests/fixtures/linecard.json (the
 * Playwright config does). Without it, nothing changes.
 */
function linecardOverride() {
  const file = process.env.LINECARD_FILE && resolve(import.meta.dirname, process.env.LINECARD_FILE);
  const handler = (req, res, next) => {
    if (!file || (req.url ?? '').split('?')[0] !== '/linecard.json') return next();
    res.setHeader('Content-Type', 'application/json');
    createReadStream(file).pipe(res);
  };
  let outDir;
  return {
    name: 'linecard-override',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    // Runs before the service-worker plugin (listed first), so the cached
    // copy and the shell version include the replaced file.
    closeBundle() {
      if (file) copyFileSync(file, resolve(outDir, 'linecard.json'));
    },
  };
}

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
  plugins: [devDatasheets(), linecardOverride(), serviceWorker()],
  build: {
    target: 'safari18',
  },
});
