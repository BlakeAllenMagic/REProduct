// Phase 5, feature 1: search by part number, and sorting the parts table.

import { test, expect } from '@playwright/test';

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

const results = (page) => page.locator('.search-result strong');

test.describe('search', () => {
  test('opens from any screen with the text box ready to type', async ({ page }) => {
    for (const hash of ['#/', '#/category/mixer', '#/settings']) {
      await page.goto(hash);
      await press(page, page.getByRole('button', { name: 'Search parts' }));
      await expect(page.locator('.search-input')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.search-overlay')).toHaveCount(0);
    }
  });

  test('finds a part number typed loosely, and opens its datasheet', async ({ page }) => {
    await page.goto('#/');
    await press(page, page.getByRole('button', { name: 'Search parts' }));
    await page.keyboard.type('alm12');
    await expect(results(page)).toHaveText(['ALM-1234']);
    await press(page, page.locator('.search-result').first());
    await expect(page).toHaveURL(/#\/part\/acme-alm1234$/);
    await expect(page.locator('.search-overlay')).toHaveCount(0);
  });

  test('Enter opens the top result', async ({ page }) => {
    await page.goto('#/');
    await page.getByRole('button', { name: 'Search parts' }).click();
    await page.keyboard.type('ksf 1575');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/part\/kestrel-ksf1575$/);
  });

  test('matches manufacturer and description too', async ({ page }) => {
    await page.goto('#/');
    await page.getByRole('button', { name: 'Search parts' }).click();
    await page.keyboard.type('gnss');
    await expect(results(page)).toHaveText(['NLA-0310']);
    await page.locator('.search-input').fill('northwind');
    await expect(results(page)).toHaveCount(3);
  });

  test('says when nothing matches, and closes with the button or outside tap', async ({ page }) => {
    await page.goto('#/');
    await page.getByRole('button', { name: 'Search parts' }).click();
    await page.keyboard.type('zzzz');
    await expect(page.locator('.search-hint')).toContainText('No parts match');
    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(page.locator('.search-overlay')).toHaveCount(0);

    await page.getByRole('button', { name: 'Search parts' }).click();
    const { height } = page.viewportSize();
    await page.mouse.click(10, height - 10); // the dimmed area below the panel
    await expect(page.locator('.search-overlay')).toHaveCount(0);
  });

  test('marks parts whose datasheet is saved', async ({ page }) => {
    await page.goto('#/settings');
    await page.getByRole('button', { name: 'Download all' }).click();
    await expect(page.locator('.big-stat')).toContainText('5 of 5');
    await page.getByRole('button', { name: 'Search parts' }).click();
    await page.keyboard.type('alm');
    const saved = (mpn) => page.locator('.search-result', { hasText: mpn }).locator('.search-saved');
    await expect(saved('ALM-1234')).toHaveText('Saved');
    await expect(saved('ALM-2280')).toHaveCount(0); // no datasheet file
  });
});

test.describe('sort', () => {
  // Waits until the table is on screen, then reads the part numbers in order.
  const order = async (page) => {
    await expect(page.locator('.part-row').first()).toBeVisible();
    return page.locator('.part-row th[scope="row"] a').allTextContents();
  };
  const header = (page, name) => page.locator('th.sortable', { hasText: name }).locator('.sort-button');

  test('a spec header sorts best first, then reversed, then back to normal', async ({ page }) => {
    await page.goto('#/category/filter');
    const normal = await order(page);
    expect(normal).toEqual(['AFB-2450', 'AFH-1000', 'KSF-1575', 'NFL-6000']);

    await press(page, header(page, 'IL (dB)')); // insertion loss: lower is better
    expect(await order(page)).toEqual(['AFH-1000', 'NFL-6000', 'KSF-1575', 'AFB-2450']); // 0.6, 0.8, 0.9, 1.2
    await expect(page.locator('th.sortable', { hasText: 'IL (dB)' })).toHaveAttribute('aria-sort', 'ascending');
    await expect(header(page, 'IL (dB)').locator('.sort-arrow')).toHaveText('▲');

    await press(page, header(page, 'IL (dB)'));
    expect(await order(page)).toEqual(['AFB-2450', 'KSF-1575', 'NFL-6000', 'AFH-1000']);
    await expect(page.locator('th.sortable', { hasText: 'IL (dB)' })).toHaveAttribute('aria-sort', 'descending');

    await press(page, header(page, 'IL (dB)'));
    expect(await order(page)).toEqual(normal);
    await expect(page.locator('th.sortable', { hasText: 'IL (dB)' })).toHaveAttribute('aria-sort', 'none');
  });

  test('"higher is better" specs start highest first; missing values go last', async ({ page }) => {
    await page.goto('#/category/lna');
    await press(page, header(page, 'OP1dB (dBm)')); // desc in categories.yaml; KLN-4020 has none
    expect(await order(page)).toEqual(['ALM-1234', 'ALM-2280', 'NLA-0310', 'KLN-4020']); // 20, 16, 8, –
    await press(page, header(page, 'OP1dB (dBm)'));
    expect((await order(page)).at(-1)).toBe('KLN-4020'); // still last when reversed
  });

  test('the sort is kept after opening a datasheet and coming back', async ({ page }) => {
    await page.goto('#/category/lna');
    await press(page, header(page, 'NF (dB)'));
    const sorted = await order(page);
    expect(sorted[0]).toBe('ALM-1234'); // 0.6 dB
    await press(page, page.locator('.part-row', { hasText: 'NLA-0310' }).locator('td').first());
    await expect(page).toHaveURL(/#\/part\//);
    await press(page, page.locator('#back'));
    expect(await order(page)).toEqual(sorted);
    await expect(page.locator('th.sortable', { hasText: 'NF (dB)' })).toHaveAttribute('aria-sort', 'ascending');
  });

  test('sort buttons are at least 44 points tall', async ({ page }) => {
    await page.goto('#/category/mixer');
    const box = await header(page, 'Conv Loss (dB)').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

// Not search or sort, but the same "everyday screens" file: the Parts sheet
// card in Settings, driven by public/import-status.json.
test.describe('parts sheet status', () => {
  const serveStatus = (page, status) =>
    page.route('**/import-status.json', (route) => route.fulfill({ json: status }));

  test('shows when the sheet is up to date', async ({ page }) => {
    await serveStatus(page, { ok: true, problems: [], warnings: [], importedAt: '2026-11-24T10:00:00Z' });
    await page.goto('#/settings');
    await expect(page.locator('.sheet-ok')).toContainText('Up to date. Last change imported');
    // No link in the status file: no button.
    await expect(page.getByRole('link', { name: 'Open the Google Sheet' })).toHaveCount(0);
  });

  test('links to the Google Sheet, and only to a Google Sheets address', async ({ page }) => {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit';
    await serveStatus(page, { ok: true, problems: [], warnings: [], importedAt: null, sheetUrl });
    await page.goto('#/settings');
    const link = page.getByRole('link', { name: 'Open the Google Sheet' });
    await expect(link).toHaveAttribute('href', sheetUrl);
    await expect(link).toHaveAttribute('target', '_blank');

    await serveStatus(page, { ok: true, problems: [], warnings: [], importedAt: null, sheetUrl: 'javascript:alert(1)' });
    await page.reload();
    await expect(page.locator('.sheet-ok')).toBeVisible();
    await expect(link).toHaveCount(0);
  });

  test('lists the problems to fix, in the sheet\'s words', async ({ page }) => {
    await serveStatus(page, {
      ok: false,
      problems: ["Low Noise Amplifiers tab, row 2: NF (dB): '0.6 GHz' has unit GHz, expected dB"],
      warnings: ["Filters tab, row 3: Package: '603' looks like Excel removed a leading zero"],
      importedAt: '2026-11-24T10:00:00Z',
    });
    await page.goto('#/settings');
    await expect(page.locator('.card', { hasText: 'Parts sheet' }).locator('.error-text')).toContainText(
      'The sheet has 1 problem to fix.',
    );
    await expect(page.locator('.sheet-problems li')).toHaveText([
      "Low Noise Amplifiers tab, row 2: NF (dB): '0.6 GHz' has unit GHz, expected dB",
    ]);
    await expect(page.locator('.sheet-warnings li')).toHaveCount(1);
  });

  test('copes with a missing status file', async ({ page }) => {
    await page.route('**/import-status.json', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await page.goto('#/settings');
    await expect(page.locator('.card', { hasText: 'Parts sheet' })).toContainText('Import status not available.');
    // The browser itself logs the 404 this test causes on purpose; nothing else may appear.
    test.info().problems = test.info().problems.filter((p) => !/404|Failed to load resource/.test(p));
  });
});
