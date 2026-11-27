// Vite plugin: builds dist/sw.js after everything else is built.
//
// The service worker needs the exact list of app files to save for offline
// use, but Vite gives files content-hashed names (index-B2Bo.js) that are only
// known after the build. So, once the build is written, this plugin:
//   1. lists every file in dist/ (the "app shell"),
//   2. fails the build if they add up to more than 10 MB (CLAUDE.md limit),
//   3. computes a version from the files' contents, and
//   4. writes src/sw.js to dist/sw.js with the list and version filled in.
//
// The version is a hash of the content, so any change to any app file gives
// a new service worker (and the app shows "Update ready"), and a build with no
// changes gives the same one (no needless re-download).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const MAX_SHELL_BYTES = 10 * 1024 * 1024;

export function serviceWorker({ source = 'src/sw.js', output = 'sw.js' } = {}) {
  let outDir;
  let root;
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = listFiles(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        // Not part of the offline app: source maps, datasheets, and the sample
        // "manufacturer" PDFs that only the sync job downloads.
        .filter(
          (path) =>
            path !== output &&
            !path.endsWith('.map') &&
            !path.startsWith('datasheets/') &&
            !path.startsWith('sample-upstream/'),
        )
        .sort();

      let total = 0;
      const versionHash = createHash('sha256');
      for (const path of files) {
        const content = readFileSync(join(outDir, path));
        total += content.length;
        versionHash.update(path).update('\0').update(content).update('\0');
      }
      if (total > MAX_SHELL_BYTES) {
        throw new Error(
          `App shell is ${(total / 1024 / 1024).toFixed(1)} MB, over the 10 MB limit in CLAUDE.md.`,
        );
      }
      // The worker's own code counts too: a change to it alone (like a new
      // install check) must still get a fresh cache name.
      versionHash.update('sw.js\0').update(readFileSync(resolve(root, source)));
      const version = versionHash.digest('hex').slice(0, 10);
      // The page is saved under "./", its real address. Hosts like Cloudflare
      // Pages redirect /index.html to /, and a redirected page can't be used
      // to answer a page load (the browser shows ERR_FAILED).
      const precache = files.map((path) => (path === 'index.html' ? './' : path));

      const template = readFileSync(resolve(root, source), 'utf8');
      if (!template.includes("'__SHELL_VERSION__'") || !template.includes('__PRECACHE__;')) {
        throw new Error(`${source} is missing its __SHELL_VERSION__ or __PRECACHE__ placeholder`);
      }
      const sw = template
        .replace("'__SHELL_VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__;', `${JSON.stringify(precache, null, 2)};`);
      writeFileSync(join(outDir, output), sw);

      console.log(`\nsw.js: shell-${version}, ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
    },
  };
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
