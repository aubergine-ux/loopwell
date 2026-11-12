// Takes the README screenshots into docs/. Run with: npm run build && npx tsx scripts/screenshots.ts

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './_browser';

const docs = join(dirname(fileURLToPath(import.meta.url)), '../docs');
const SHOTS = [
  { theme: 'cream', demo: 'Night Drive', tab: 'Sound', track: 0 },
  { theme: 'night', demo: 'Glass Hours', tab: 'Keys', track: 7 },
  { theme: 'slate', demo: 'Dust Loop', tab: 'Mix', track: 6 },
  { theme: 'arcade', demo: 'Punch Card', tab: 'FX', track: 6 },
];

const b = await launch({ width: 1360, height: 880, scale: 1.5 });
const { page } = b;
await page.addInitScript(() => localStorage.setItem('loopwell:theme', 'cream'));
await page.goto(b.url);
await page.waitForSelector('.cell');
for (const s of SHOTS) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, s.theme);
  await page.getByTitle('Demo beats and new beat').click();
  await page.getByText(s.demo).click();
  await page.locator(`.row[data-row="${s.track}"] .name`).click();
  await page.getByRole('tab', { name: s.tab }).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(1700);
  await page.screenshot({ path: join(docs, `theme-${s.theme}.png`) });
  await page.keyboard.press('Space');
}
await b.close();

const t = await launch({ width: 820, height: 1120, scale: 1.5, touch: true });
await t.page.addInitScript(() => localStorage.setItem('loopwell:theme', 'night'));
await t.page.goto(t.url);
await t.page.getByTitle('Demo beats and new beat').click();
await t.page.getByText('Night Drive').click();
await t.page.waitForTimeout(1500);
await t.page.screenshot({ path: join(docs, 'tablet.png') });
await t.close();
process.exit(0);
