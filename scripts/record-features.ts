// Records the README's opening clip: the newer parts of Loopwell in twenty
// seconds. Live code typed while a beat plays, the mastering chain switched
// on, then a beat recreated by ear in learn mode.
// Writes docs/features.gif (needs ffmpeg). Run with: npm run build && npx tsx scripts/record-features.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../src/core/templates';
import { launch } from './_browser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'loopwell-features-'));
const W = 1280, H = 850;
const b = await launch({ width: W, height: H, video: dir });
const { page } = b;

// start on the house template, and draw a pointer (headless video has no cursor)
const house = TEMPLATES.find((t) => t.id === 'house')!.make();
house.patterns[0].steps[3].fill(0); // the hats are left for the code to play
await page.addInitScript((project) => {
  localStorage.setItem('loopwell:project', project);
  localStorage.setItem('loopwell:theme', 'cream');
  localStorage.setItem('loopwell:toured', '1');
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;left:-50px;top:-50px;transition:transform .08s';
    document.body.append(c);
    addEventListener('pointermove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('pointerdown', () => (c.style.transform = 'scale(.7)'), true);
    addEventListener('pointerup', () => (c.style.transform = ''), true);
  });
}, JSON.stringify(house));

const wait = (ms: number) => page.waitForTimeout(ms);
async function click(sel: string, pause = 250): Promise<void> {
  const r = (await page.locator(sel).first().boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 10 });
  await page.mouse.down();
  await wait(50);
  await page.mouse.up();
  await wait(pause);
}
const cell = (t: number, s: number) => `.cell[data-t="${t}"][data-s="${s}"]`;
const tab = (name: string) => `[role="tab"]:text-is("${name}")`;

await page.goto(b.url);
await page.waitForSelector('.cell.on');
await wait(600);
const t0 = Date.now();

// 1. a beat is playing; hats are typed in as code and join on the next step
await click('.tbtn.play', 900);
await click(tab('Code'), 400);
await click('textarea[aria-label="Live code"]', 200);
await page.keyboard.type('hat:  [x x x]*4', { delay: 75 });
await wait(1500);
await page.keyboard.press('Enter');
await page.keyboard.type('perc: x(3,8)?', { delay: 75 });
await wait(2200);

// 2. the mastering chain: pick a style, hear it get louder and wider
await click(tab('Master'), 500);
await page.getByLabel('Mastering style').selectOption({ label: 'House' });
await wait(1800);

// 3. learn mode: hear a beat, rebuild it, watch the meter climb
await page.keyboard.press('Escape');
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette input');
await page.keyboard.type('learn', { delay: 70 });
await wait(400);
await page.keyboard.press('Enter');
await page.waitForSelector('.modal .list');
await wait(900);
await click('.modal .list button:has-text("Four on the floor")', 900);
await page.waitForSelector('.challenge');
await wait(1200);
for (const s of [0, 4, 8, 12]) await click(cell(0, s), 140);
for (const s of [4, 12]) await click(cell(2, s), 140);
for (const s of [2, 6, 10, 14]) await click(cell(3, s), 140);
await wait(700);
await click('.challenge .btn:has-text("Hear mine")', 2600);
const total = (Date.now() - t0) / 1000;

await b.close();
const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))!);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '0.6', '-t', String(total), '-i', file,
  '-vf', 'fps=10,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  join(root, 'docs/features.gif')]);
console.log(`wrote docs/features.gif (${total.toFixed(1)}s)`);
process.exit(0);
