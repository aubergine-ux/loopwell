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
  // the dialog opens on your own beats once there are some
  await page.getByRole('radio', { name: 'Demos' }).click();
  await page.locator('.modal').getByText(s.demo).click();
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
// the high-contrast theme, on the mixer
await page.evaluate(() => { document.documentElement.dataset.theme = 'contrast'; });
await page.getByRole('tab', { name: 'Mix' }).click();
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
await page.screenshot({ path: join(docs, 'theme-contrast.png') });
await page.keyboard.press('Space');

// ---- the newer parts, one picture each ----
const palette = async (what: string) => { await page.keyboard.press('Control+k'); await page.waitForSelector('.palette input'); await page.keyboard.type(what); await page.keyboard.press('Enter'); };
const template = async (name: string) => {
  await page.getByTitle('Demo beats and new beat').click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: name }).click();
  await page.waitForSelector('.cell.ph');
};

// live code, playing
await page.evaluate(() => { document.documentElement.dataset.theme = 'night'; });
await template('House');
await page.getByRole('tab', { name: 'Code' }).click();
await page.getByLabel('Live code').fill('// typed while it plays; heard from the next step\nhat:   [x x x]*4\nperc:  x(3,8)?\nlead:  <c4 eb4 g4 bb4>*2 ~ [c5 g4]/2\nsnare: ~ x ~ [x x]');
await page.getByLabel('Live code').blur();
await page.mouse.move(5, 5);
await page.waitForTimeout(1600);
await page.screenshot({ path: join(docs, 'shot-code.png') });
await page.keyboard.press('Space');

// a plugin's window
await page.evaluate(() => { document.documentElement.dataset.theme = 'slate'; });
await page.locator('.row[data-row="7"] .name').click();
await page.getByRole('tab', { name: 'Sound' }).click();
await page.locator('.sound .seg button', { hasText: 'Plugin' }).click();
await page.locator('.modal .plugin', { hasText: 'Pluck' }).click();
await page.waitForFunction(() => !(document.querySelector('.plugs .chain li .btn') as HTMLButtonElement | null)?.disabled && !!document.querySelector('.plugs .chain li'));
await page.locator('.plugs .chain li .btn', { hasText: 'Open' }).first().click();
await page.waitForSelector('.modal .face input[type="range"]');
await page.waitForTimeout(500);
await page.screenshot({ path: join(docs, 'shot-plugin.png') });
await page.getByRole('button', { name: 'Close' }).click();

// the video export
await page.evaluate(() => { document.documentElement.dataset.theme = 'cream'; });
await palette('export a video');
await page.waitForSelector('.modal canvas');
await page.waitForFunction(() => !document.querySelector('.modal .wait'), undefined, { timeout: 60000 });
await page.getByRole('radio', { name: 'Pads', exact: true }).click();
await page.getByLabel('Producer tag shown in the video').fill('prod. you');
await page.waitForTimeout(900);
await page.screenshot({ path: join(docs, 'shot-video.png') });
await page.getByRole('button', { name: 'Close' }).click();

// recreating a beat in learn mode
await page.evaluate(() => { document.documentElement.dataset.theme = 'arcade'; });
await palette('learn lessons');
await page.locator('.modal .list button', { hasText: 'Trap bounce' }).click();
await page.waitForSelector('.challenge');
for (const [t, steps] of [[0, [0, 6, 9]], [2, [8]], [3, [0, 2, 4, 6, 8]], [3, [5]]] as [number, number[]][]) for (const st of steps) await page.locator(`.cell[data-t="${t}"][data-s="${st}"]`).click();
await page.locator('.challenge .btn', { hasText: 'Peek' }).click();
await page.mouse.move(5, 5);
await page.waitForTimeout(600);
await page.screenshot({ path: join(docs, 'shot-learn.png') });
await b.close();

const t = await launch({ width: 820, height: 1120, scale: 1.5, touch: true });
await t.page.addInitScript(() => localStorage.setItem('loopwell:theme', 'night'));
await t.page.goto(t.url);
await t.page.getByTitle('Demo beats and new beat').click();
await t.page.getByRole('radio', { name: 'Demos' }).click();
await t.page.locator('.modal').getByText('Night Drive').click();
await t.page.getByRole('button', { name: 'Pads', exact: true }).click();
await t.page.locator('.perform .pad[data-pad="6"]').tap();
await t.page.waitForTimeout(1500);
await t.page.screenshot({ path: join(docs, 'tablet.png') });
await t.close();
process.exit(0);
