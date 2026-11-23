// The core flow from CLAUDE.md: diagram -> block -> parts table -> datasheet.

import { test, expect } from '@playwright/test';

// Any uncaught error or console error fails the test, so nothing breaks silently.
test.beforeEach(async ({ page }) => {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  test.info().problems = problems;
});

test.afterEach(async () => {
  expect(test.info().problems, 'errors in the browser').toEqual([]);
});

/** Tap on touch devices, click elsewhere. */
async function press(page, locator) {
  if (test.info().project.use.hasTouch) await locator.tap();
  else await locator.click();
}

test('diagram shows part counts and disables empty blocks', async ({ page }) => {
  await page.goto('#/');
  const badge = (block) => page.locator(`[data-block="${block}"] .block-badge text`);
  await expect(badge('lna')).toHaveText('4');
  await expect(badge('mixer')).toHaveText('3');
  await expect(badge('rf_filter')).toHaveText('4');
  await expect(badge('if_filter')).toHaveText('4');
  for (const block of ['lo', 'if_amp', 'adc']) {
    await expect(page.locator(`[data-block="${block}"]`)).toHaveClass(/is-disabled/);
    await expect(badge(block)).toHaveCount(0);
  }
});

test('full tap flow: block, table, datasheet, and back', async ({ page }) => {
  await page.goto('#/');

  await press(page, page.locator('[data-block="lna"]'));
  await expect(page).toHaveURL(/#\/category\/lna$/);
  await expect(page.locator('#title')).toHaveText('Low Noise Amplifiers');
  await expect(page.locator('.part-row')).toHaveCount(4);
  await expect(page.locator('.parts-table thead')).toContainText('NF (dB)');

  await press(page, page.locator('.part-row', { hasText: 'ALM-1234' }).locator('td').first());
  await expect(page).toHaveURL(/#\/part\/acme-alm1234$/);
  await expect(page.locator('#title')).toHaveText('ALM-1234');

  // Fresh browser: nothing saved yet, so download it from the viewer.
  await expect(page.getByRole('heading', { name: 'Not downloaded' })).toBeVisible();
  await press(page, page.getByRole('button', { name: 'Download now' }));

  // The PDF loads and the first page is drawn.
  const pageLabel = page.locator('.viewer-label').first();
  const zoomLabel = page.locator('.viewer-label').nth(1);
  await expect(pageLabel).toHaveText('1 / 7');
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);
  expect(await canvasHasInk(page, 1)).toBe(true);

  // Page navigation.
  await press(page, page.getByRole('button', { name: 'Next page' }));
  await expect(pageLabel).toHaveText('2 / 7');
  await press(page, page.getByRole('button', { name: 'Previous page' }));
  await expect(pageLabel).toHaveText('1 / 7');

  // Zoom buttons.
  await press(page, page.getByRole('button', { name: 'Zoom in' }));
  await expect(zoomLabel).toHaveText('125%');
  await press(page, page.getByRole('button', { name: 'Fit page width' }));
  await expect(zoomLabel).toHaveText('100%');

  // Back to the table, then the diagram.
  await press(page, page.locator('#back'));
  await expect(page).toHaveURL(/#\/category\/lna$/);
  await press(page, page.locator('#back'));
  await expect(page).toHaveURL(/#\/$/);
});

test('only pages near the screen keep a canvas', async ({ page }) => {
  await downloadAll(page);
  await page.goto('#/part/acme-alm1234');
  await expect(page.locator('.viewer-label').first()).toHaveText('1 / 7');
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.viewer-label').first()).toHaveText('7 / 7');
  await expect(page.locator('.pdf-page[data-page="7"] canvas')).toHaveCount(1);
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(0);
});

test('a part without a datasheet file says so and links to the maker', async ({ page }) => {
  await page.goto('#/part/kestrel-kln4020');
  await expect(page.getByRole('heading', { name: 'No datasheet in the app' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Kestrel Semiconductor website/ })).toHaveAttribute(
    'href',
    'https://kestrel.example/pdf/KLN-4020.pdf',
  );
});

test('unknown links show a clear message', async ({ page }) => {
  await page.goto('#/category/nope');
  await expect(page.getByRole('heading', { name: 'Category not found' })).toBeVisible();
  await page.goto('#/part/nope');
  await expect(page.getByRole('heading', { name: 'Part not found' })).toBeVisible();
});

test('two-finger pinch zooms the datasheet', async ({ page, browserName, context }) => {
  // Synthetic multi-touch needs Chrome's DevTools protocol. Safari's own
  // pinch events can only be tested on a real Apple device.
  test.skip(browserName !== 'chromium', 'multi-touch simulation is Chromium-only');
  await page.setViewportSize({ width: 820, height: 1180 });
  await downloadAll(page);
  await page.goto('#/part/acme-amx0750');
  const zoomLabel = page.locator('.viewer-label').nth(1);
  await expect(zoomLabel).toHaveText('100%');

  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  await touch('touchStart', [
    [350, 600],
    [470, 600],
  ]);
  for (let d = 70; d <= 150; d += 10) {
    await touch('touchMove', [
      [410 - d, 600],
      [410 + d, 600],
    ]);
  }
  await touch('touchEnd', []);
  await expect(zoomLabel).toHaveText('250%'); // fingers went from 120 px to 300 px apart
});

test('Settings: Download all saves every datasheet', async ({ page }) => {
  await page.goto('#/settings');
  await expect(page.locator('.big-stat')).toContainText('0 of 5');
  await press(page, page.getByRole('button', { name: 'Download all' }));
  await expect(page.locator('.download-progress')).toContainText('Download complete');
  await expect(page.locator('.download-progress')).toContainText('5 / 5 files');
  await expect(page.locator('.big-stat')).toContainText('5 of 5');
  await expect(page.getByText(/Last synced/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'All datasheets saved' })).toBeDisabled();
});

test('parts table: download one category and see its status', async ({ page }) => {
  await page.goto('#/category/filter');
  const row = (mpn) => page.locator('.part-row', { hasText: mpn }).locator('td.status');
  await expect(row('AFB-2450')).toHaveText('Not saved');
  await expect(row('AFH-1000')).toHaveText('–'); // no datasheet file
  await press(page, page.getByRole('button', { name: /Download this category \(2\)/ }));
  await expect(row('AFB-2450')).toHaveText('Saved');
  await expect(row('KSF-1575')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'All datasheets saved' })).toBeDisabled();

  // Other categories were not downloaded.
  await page.goto('#/settings');
  await expect(page.locator('.big-stat')).toContainText('2 of 5');
});

test('storage full: clear message and the app keeps working', async ({ page, browserName, context }) => {
  test.skip(browserName !== 'chromium', 'storage quota simulation is Chromium-only');
  await page.goto('#/settings');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', {
    origin: new URL(page.url()).origin,
    quotaSize: 12 * 1024, // 12 KB: room for some of the 23 KB of samples
  });
  await page.reload();

  // The space check warns first; say "download anyway".
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.download-progress')).toContainText('Stopped: storage full');
  await expect(page.getByText(/ran out of storage space/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry failed' })).toBeVisible();
  // The app still works.
  await page.goto('#/category/lna');
  await expect(page.locator('.part-row')).toHaveCount(4);
});

async function downloadAll(page) {
  await page.goto('#/settings');
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.big-stat')).toContainText('5 of 5');
}

/** True if the page's canvas has any non-white pixels (it really drew). */
async function canvasHasInk(page, pageNumber) {
  return page.locator(`.pdf-page[data-page="${pageNumber}"] canvas`).evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
    }
    return false;
  });
}
