// Takes the README screenshots into docs/. Run with: npm run build && npx tsx scripts/screenshots.ts

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './_browser';

const docs = join(dirname(fileURLToPath(import.meta.url)), '../docs');
const SHOTS = [
  { theme: 'cream', demo: 'Night Drive', tab: 'Mix', track: 6, song: true },
  { theme: 'night', demo: 'Glass Hours', tab: 'Keys', track: 7, song: false },
  { theme: 'slate', demo: 'Dust Loop', tab: 'Sound', track: 6, song: false },
  { theme: 'arcade', demo: 'Punch Card', tab: 'Rack', track: 6, song: false },
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
  // every demo opens in the song view; step into the pattern to pick a track, then go where the shot wants to be
  await page.getByRole('button', { name: 'Pattern', exact: true }).click();
  await page.locator(`.row[data-row="${s.track}"] .name`).click();
  await page.getByRole('tab', { name: s.tab }).click();
  if (s.tab === 'Rack') for (const fx of ['EQ', 'Drive', 'Sidechain']) await page.getByRole('button', { name: `Add ${fx}` }).click();
  if (s.song) {
    await page.getByRole('button', { name: 'Song', exact: true }).click();
    await page.getByRole('button', { name: 'Add automation to BASS' }).click();
    const lane = (await page.locator('svg.curve').first().boundingBox())!;
    await page.mouse.move(lane.x + 4, lane.y + lane.height - 8);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(lane.x + 4 + i * 24, lane.y + lane.height / 2 - Math.sin(i / 6) * 18, { steps: 2 });
    await page.mouse.up();
    await page.mouse.click(lane.x + 16 * 8 * 4 + 2, lane.y - 300 > 0 ? (await page.locator('.ruler').boundingBox())!.y + 10 : 0);
    await page.getByTitle('Add a marker at the cursor').click();
    await page.keyboard.press('Space');
  }
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
await t.page.getByRole('button', { name: 'Pads', exact: true }).click();
await t.page.locator('.perform .pad[data-pad="6"]').tap();
await t.page.waitForTimeout(1500);
await t.page.screenshot({ path: join(docs, 'tablet.png') });
await t.close();
process.exit(0);
