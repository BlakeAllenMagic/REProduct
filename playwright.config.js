// Automated tests in real browser engines. Run: npm run test:e2e
//
// Two kinds:
//   tap-flow.spec.js  runs against the dev server (fast, no service worker)
//   offline.spec.js   runs against the BUILT app (vite build + vite preview),
//                     because only the built app has a service worker
//
// WebKit is the engine inside Safari. It catches most "works in Chrome,
// breaks in Safari" bugs, but it is not iPad Safari: see "Apple device check"
// in CLAUDE.md for what only a real iPad can show.
//
// First time on a new machine: npx playwright install chromium webkit

import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 5174; // separate from the normal dev server (5173)
const BUILT_PORT = 4174; // separate from the normal preview server (4173)
const OFFLINE = /offline\.spec\.js/;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: { trace: 'off' },
  projects: [
    { name: 'chromium', testIgnore: OFFLINE, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEV_PORT}/` } },
    { name: 'webkit', testIgnore: OFFLINE, use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${DEV_PORT}/` } },
    // Safari's engine with an iPad-sized touch screen.
    {
      name: 'webkit-ipad',
      testIgnore: OFFLINE,
      use: { ...devices['iPad Pro 11 landscape'], baseURL: `http://localhost:${DEV_PORT}/` },
    },
    // The built app, with its service worker.
    {
      name: 'offline-chromium',
      testMatch: OFFLINE,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${BUILT_PORT}/` },
    },
    {
      name: 'offline-webkit',
      testMatch: OFFLINE,
      use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${BUILT_PORT}/` },
    },
  ],
  webServer: [
    {
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // Built into its own folder so it never clashes with your own `npm run build`.
      command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${BUILT_PORT} --strictPort`,
      url: `http://localhost:${BUILT_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
