// Renders public/icon.svg to the PNG sizes the web app manifest needs.
// Run with: npx tsx scripts/build-icons.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const pub = join(dirname(fileURLToPath(import.meta.url)), '../public');
const svg = readFileSync(join(pub, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.12]] as const) {
  await page.setViewportSize({ width: size, height: size });
  // maskable icons need a safe zone, so the artwork is inset on a full-bleed background
  await page.setContent(`<body style="margin:0;background:${pad ? '#1d1b18' : 'transparent'};display:grid;place-items:center;height:100vh">
    <div style="width:${size * (1 - pad * 2)}px;height:${size * (1 - pad * 2)}px">${svg}</div></body>`);
  await page.screenshot({ path: join(pub, name), omitBackground: !pad });
}
await browser.close();
