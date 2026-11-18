// Automated tap-flow tests in real browser engines. Run: npm run test:e2e
//
// WebKit is the engine inside Safari. It catches most "works in Chrome,
// breaks in Safari" bugs, but it is not iPad Safari: see "Apple device check"
// in CLAUDE.md for what only a real iPad can show.
//
// First time on a new machine: npx playwright install chromium webkit

import { defineConfig, devices } from '@playwright/test';

const PORT = 5174; // separate from the normal dev server (5173)

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Safari's engine with an iPad-sized touch screen.
    { name: 'webkit-ipad', use: { ...devices['iPad Pro 11 landscape'] } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
