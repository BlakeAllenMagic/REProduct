// "Send datasheet" and "Email link" (phase 3).
//
// The real share sheet is an operating-system window a test can't drive, so
// a stand-in replaces navigator.share and records what the app gave it:
// the file's name, type, size and SHA-256, and whether the call happened
// during the tap (navigator.userActivation.isActive), which Safari requires.
// mailto links are recorded instead of opening a mail app.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const linecard = JSON.parse(readFileSync(new URL('../fixtures/linecard.json', import.meta.url)));
const partById = (id) => linecard.parts.find((p) => p.id === id);

/** Installs the stand-ins. canShareFiles=false acts like a browser that can't share files. */
function installStandIns({ canShareFiles = true } = {}) {
  window.__shares = [];
  window.__mailto = [];
  window.__shareOutcome = 'ok';
  if (canShareFiles) {
    navigator.canShare = (data) =>
      Array.isArray(data?.files) && data.files.every((file) => file instanceof File);
    navigator.share = async (data) => {
      // Read this first, before any await, like the real check.
      const active = navigator.userActivation ? navigator.userActivation.isActive : null;
      const file = data.files[0];
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      window.__shares.push({
        count: data.files.length,
        name: file.name,
        type: file.type,
        size: file.size,
        sha,
        title: data.title,
        text: data.text,
        active,
      });
      if (window.__shareOutcome === 'cancel') throw new DOMException('closed', 'AbortError');
      if (window.__shareOutcome === 'refuse') throw new DOMException('no tap', 'NotAllowedError');
    };
  } else {
    delete Navigator.prototype.canShare;
    delete Navigator.prototype.share;
  }
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href.startsWith('mailto:')) window.__mailto.push(this.href);
    else click.call(this);
  };
}

test.beforeEach(async ({ page }) => {
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  test.info().problems = problems;
});

test.afterEach(async () => {
  expect(test.info().problems, 'uncaught errors in the browser').toEqual([]);
});

async function openDownloaded(page, partId) {
  await page.goto('#/settings');
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.big-stat')).toContainText('5 of 5');
  await page.goto(`#/part/${partId}`);
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(1);
}

function mailtoParts(href) {
  const params = new URLSearchParams(href.slice('mailto:?'.length));
  return { subject: params.get('subject'), body: params.get('body') };
}

test('Send datasheet shares the complete PDF, during the tap', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await openDownloaded(page, 'acme-alm1234');
  const part = partById('acme-alm1234');

  await page.getByRole('button', { name: 'Send datasheet' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  const [share] = await page.evaluate(() => window.__shares);

  expect(share.count).toBe(1);
  expect(share.name).toBe('Acme RF ALM-1234 datasheet.pdf');
  expect(share.type).toBe('application/pdf');
  expect(share.size).toBe(part.datasheet.bytes);
  expect(share.sha).toBe(part.datasheet.sha256); // the full PDF, not an empty copy
  expect(share.active).not.toBe(false); // called inside the tap
  expect(share.title).toBe('ALM-1234 datasheet (Acme RF)');
  expect(share.text).toContain('attached is the datasheet');
});

test('Email link opens a prefilled email with the manufacturer link', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await openDownloaded(page, 'acme-alm1234');
  await page.getByRole('button', { name: 'Email link' }).click();
  const [href] = await page.evaluate(() => window.__mailto);
  const { subject, body } = mailtoParts(href);
  expect(subject).toBe('ALM-1234 datasheet (Acme RF)');
  expect(body).toContain('https://reproduct.pages.dev/sample-upstream/ALM-1234.pdf');
  expect(await page.evaluate(() => window.__shares.length)).toBe(0);
});

test('a browser that cannot share files only offers Email link', async ({ page }) => {
  await page.addInitScript(installStandIns, { canShareFiles: false });
  await openDownloaded(page, 'acme-alm1234');
  await expect(page.getByRole('button', { name: 'Send datasheet' })).toBeHidden();
  await page.getByRole('button', { name: 'Email link' }).click();
  const [href] = await page.evaluate(() => window.__mailto);
  expect(mailtoParts(href).body).toContain('https://reproduct.pages.dev/sample-upstream/ALM-1234.pdf');
});

test('not downloaded: Send is hidden, Email link still works', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await page.goto('#/part/acme-amx0750');
  await expect(page.getByRole('heading', { name: 'Not downloaded' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send datasheet' })).toBeHidden();
  await page.getByRole('button', { name: 'Email link' }).click();
  expect(await page.evaluate(() => window.__mailto.length)).toBe(1);
});

test('closing the share sheet without sending shows no error', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await openDownloaded(page, 'acme-alm1234');
  await page.evaluate(() => (window.__shareOutcome = 'cancel'));
  await page.getByRole('button', { name: 'Send datasheet' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  await page.waitForTimeout(200);
  await expect(page.locator('.error-item')).toHaveCount(0);
});

test('a refused share explains what to do', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await openDownloaded(page, 'acme-alm1234');
  await page.evaluate(() => (window.__shareOutcome = 'refuse'));
  await page.getByRole('button', { name: 'Send datasheet' }).click();
  await expect(page.locator('.error-item')).toContainText('blocked the share sheet');
  await expect(page.locator('.error-item')).toContainText('Email link');
});

test('shortlist: star parts in a table and on a part page, then send all their datasheets at once', async ({ page }) => {
  await page.addInitScript(installStandIns);
  await page.goto('#/settings');
  await page.getByRole('button', { name: 'Download all' }).click();
  await expect(page.locator('.big-stat')).toContainText('5 of 5');

  // Star two LNAs in the table (one with a saved datasheet, one without any).
  await page.goto('#/category/lna');
  const chip = page.locator('#shortlist-chip');
  await expect(chip).toBeHidden();
  await page.getByRole('button', { name: 'Add ALM-1234 to the shortlist' }).click();
  await page.getByRole('button', { name: 'Add ALM-2280 to the shortlist' }).click();
  await expect(page).toHaveURL(/#\/category\/lna$/); // the star didn't open the part
  await expect(chip).toHaveText('★ 2');
  // And one from its part page.
  await page.goto('#/part/acme-amx0750');
  await page.getByRole('button', { name: 'Add AMX-0750 to the shortlist' }).click();
  await expect(chip).toHaveText('★ 3');

  await chip.click();
  await expect(page).toHaveURL(/#\/shortlist$/);
  await expect(page.locator('.shortlist-summary')).toContainText('3 parts · 2 datasheets attached');
  await expect(page.locator('.shortlist-item')).toHaveCount(3);
  await page.getByRole('button', { name: 'Send all' }).click();
  await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(1);
  const [share] = await page.evaluate(() => window.__shares);
  expect(share.count).toBe(2); // both saved PDFs in one share
  expect(share.active).not.toBe(false); // during the tap
  expect(share.title).toBe('Datasheets: 3 parts');
  expect(share.text).toContain('Acme RF ALM-1234');
  expect(share.text).toContain('(attached)');
  expect(share.text).toContain('ALM-2280'); // no PDF here: listed with its link

  // After sending: offered to clear. "Keep" keeps it.
  await expect(page.locator('.shortlist-sent')).toContainText('Clear the shortlist?');
  await page.locator('.shortlist-sent').getByRole('button', { name: 'Keep' }).click();
  await expect(page.locator('.shortlist-sent')).toHaveCount(0);

  // Remove one; the list survives a reload.
  await page.getByRole('button', { name: 'Remove ALM-2280 from the shortlist' }).click();
  await expect(chip).toHaveText('★ 2');
  await page.reload();
  await expect(page.locator('.shortlist-item')).toHaveCount(2);

  // Email links lists every part.
  await page.getByRole('button', { name: 'Email links' }).click();
  const [href] = await page.evaluate(() => window.__mailto);
  expect(mailtoParts(href).body).toContain('AMX-0750');

  await page.locator('.shortlist-actions').getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByText('No parts on the shortlist')).toBeVisible();
  await expect(chip).toBeHidden();
});
