// Records the README demo: a beat being built from an empty grid.
// Writes docs/demo.gif (needs ffmpeg). Run with: npm run build && npx tsx scripts/record-demo.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { emptyProject } from '../src/core/types';
import { launch } from './_browser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'loopwell-demo-'));
const W = 1280, H = 850;
const b = await launch({ width: W, height: H, video: dir });
const { page } = b;

// start from a blank beat, and draw a pointer (headless video has no cursor)
await page.addInitScript((project) => {
  localStorage.setItem('loopwell:project', project);
  localStorage.setItem('loopwell:theme', 'cream');
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;transition:transform .08s;left:-50px;top:-50px';
    document.body.append(c);
    addEventListener('pointermove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('pointerdown', () => (c.style.transform = 'scale(.7)'), true);
    addEventListener('pointerup', () => (c.style.transform = ''), true);
  });
}, JSON.stringify(emptyProject()));

const wait = (ms: number) => page.waitForTimeout(ms);
async function click(sel: string | { x: number; y: number }, pause = 150): Promise<void> {
  let x: number, y: number;
  if (typeof sel === 'string') {
    const r = (await page.locator(sel).first().boundingBox())!;
    x = r.x + r.width / 2; y = r.y + r.height / 2;
  } else ({ x, y } = sel);
  await page.mouse.move(x, y, { steps: 9 });
  await page.mouse.down();
  await wait(50);
  await page.mouse.up();
  await wait(pause);
}
const step = (t: number, s: number) => `.cell[data-t="${t}"][data-s="${s}"]`;
async function steps(p: Page, t: number, list: number[]): Promise<void> {
  for (const s of list) await click(step(t, s), 90);
}

await page.goto(b.url);
await page.waitForSelector('.cell');
const t0 = Date.now();
await wait(700);

await steps(page, 0, [0, 4, 8, 12]);
await click('.tbtn.play', 500);
await steps(page, 2, [4, 12]);
await steps(page, 3, [2, 6, 10, 14]);
await steps(page, 4, [15]);
await wait(300);

// bass line in the piano roll
await click('.row[data-row="6"] .name', 200);
await click('[role=tab]:nth-child(2)', 400);
const roll = (await page.locator('.roll .scroller').boundingBox())!;
const laneX = (s: number) => roll.x + 46 + ((roll.width - 46) * (s + 0.5)) / 16;
// the roll is a scrolling list of rows; aim at the root-note row nearest the middle of what is visible
const rootY = await page.evaluate(([top, height]) => {
  const mid = top + height / 2;
  const ys = [...document.querySelectorAll('.band:not(.out)')].map((el) => el.getBoundingClientRect().top + 9);
  return ys.reduce((best, y) => (Math.abs(y - mid) < Math.abs(best - mid) ? y : best));
}, [roll.y, roll.height]);
for (const [s, row, len] of [[0, 0, 2], [3, 0, 1], [6, -2, 2], [10, 0, 2], [13, 1, 2]] as const) {
  const y = rootY + row * -18;
  await page.mouse.move(laneX(s), y, { steps: 8 });
  await page.mouse.down();
  await page.mouse.move(laneX(s + len - 1), y, { steps: 4 });
  await page.mouse.up();
  await wait(170);
}
await wait(900);

// sweep the master filter
await click('[role=tab]:nth-child(5)', 400);
const knob = (await page.locator('.fx section:nth-child(3) .knob').first().boundingBox())!;
const kx = knob.x + knob.width / 2, ky = knob.y + 30;
await page.mouse.move(kx, ky, { steps: 8 });
await page.mouse.down();
await page.mouse.move(kx, ky + 70, { steps: 28 });
await wait(250);
await page.mouse.move(kx, ky, { steps: 28 });
await page.mouse.up();
await wait(500);

// arrange it: over to the song view, stretch every part to four bars, draw a fade-in on the bass
await click('.seg.view button:nth-child(2)', 700);
for (const t of [0, 2, 3, 4, 6]) {
  const c = (await page.locator(`.lane.clips[data-lane="${t}"] .clip`).first().boundingBox())!;
  await page.mouse.move(c.x + c.width - 3, c.y + c.height / 2, { steps: 6 });
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 4 - 3, c.y + c.height / 2, { steps: 10 });
  await page.mouse.up();
  await wait(120);
}
await click('[aria-label="Add automation to BASS"]', 300);
const lane = (await page.locator('svg.curve').first().boundingBox())!;
await page.mouse.move(lane.x + 4, lane.y + lane.height - 8, { steps: 6 });
await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(lane.x + 4 + i * 25, lane.y + lane.height - 8 - i * 1.9, { steps: 2 });
await page.mouse.up();
await wait(2200);

// show off a second theme
await click('[aria-label="Change colour theme"]', 1900);
const total = (Date.now() - t0) / 1000;

await b.close();
const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))!);
const lead = 0.4; // skip the blank frames before the page paints
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(lead), '-t', String(total), '-i', file,
  '-vf', 'fps=10,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  join(root, 'docs/demo.gif')]);
console.log(`wrote docs/demo.gif (${total.toFixed(1)}s)`);
process.exit(0);
