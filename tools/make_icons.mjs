// Draws the app icons as SVG and saves them as PNGs in public/icons/.
// Uses Playwright's Chromium to turn SVG into PNG, so no image library is needed.
//
// Run: node tools/make_icons.mjs
//
// Placeholder design (an amplifier symbol); real branding comes in phase 5.

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const OUT = new URL('../public/icons/', import.meta.url);
const BLUE = '#0b5cad';

/**
 * @param {number} radius corner rounding of the background (0 = square)
 * @param {number} inset how far the symbol sits from the edge, as a fraction.
 *   Maskable icons need the symbol inside the middle 80% because launchers
 *   crop them into circles or other shapes.
 */
function iconSvg({ radius, inset }) {
  const s = 512;
  const pad = s * inset;
  const scale = (s - 2 * pad) / s;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">
  <rect width="${s}" height="${s}" rx="${radius}" fill="${BLUE}"/>
  <g transform="translate(${pad} ${pad}) scale(${scale})" fill="none" stroke="#fff"
     stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <path d="M64 256 H160"/>
    <path d="M160 128 L376 256 L160 384 Z"/>
    <path d="M376 256 H448"/>
  </g>
</svg>`;
}

const ICONS = [
  // Normal icons (browser tabs, Windows/Chrome app icons): rounded corners.
  { file: 'icon-192.png', size: 192, radius: 96, inset: 0.06 },
  { file: 'icon-512.png', size: 512, radius: 96, inset: 0.06 },
  // Maskable: full square, symbol well inside the safe zone.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, inset: 0.18 },
  // iPadOS Home Screen: full square, iPadOS rounds the corners itself.
  { file: 'apple-touch-icon-180.png', size: 180, radius: 0, inset: 0.1 },
];

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('icon.svg', OUT), iconSvg({ radius: 96, inset: 0.06 }));

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const svg = iconSvg(icon).replace(/width="512" height="512"/, `width="${icon.size}" height="${icon.size}"`);
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const png = await page.locator('svg').screenshot({ omitBackground: true });
    writeFileSync(new URL(icon.file, OUT), png);
    await page.close();
    console.log(`public/icons/${icon.file} (${icon.size}x${icon.size})`);
  }
} finally {
  await browser.close();
}
