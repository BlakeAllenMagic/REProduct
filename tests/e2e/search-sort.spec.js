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
