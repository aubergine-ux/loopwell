// Measures animation frame pacing while a busy 32-step beat plays, on every screen that draws while it does.
// Run with: npm run build && npx tsx scripts/fps-check.ts
// THROTTLE=4 slows the page's CPU four times (a mid-range laptop is about 2, a tablet about 4);
// VIEW=tablet or VIEW=phone uses that size of screen, with touch.

import { launch } from './_browser';

const view = process.env.VIEW;
const b = await launch(view === 'phone' ? { width: 390, height: 844, touch: true, scale: 2 } : view === 'tablet' ? { width: 1024, height: 768, touch: true, scale: 2 } : {});
const { page } = b;
const throttle = +(process.env.THROTTLE ?? 1);
if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
console.log(`${view ?? 'desktop'}${throttle > 1 ? `, CPU slowed ${throttle}x` : ''}`);
let slow = false;
// CALM=1 measures with "reduce motion" switched on, to see what the animations cost
if (process.env.CALM) await page.addInitScript(() => localStorage.setItem('loopwell:prefs', JSON.stringify({ calm: true })));
await page.goto(b.url);
await page.waitForSelector('.cell');
await page.getByTitle('Demo beats and new beat').click();
await page.getByText('Glass Hours').click();
await page.waitForSelector('.cell.ph');
for (const tab of (process.env.TABS ?? 'Sound,Keys,Tools,Mix,Live').split(',')) {
  if (tab === 'Live') await page.getByRole('button', { name: 'Live', exact: true }).click();
  else await page.getByRole('tab', { name: tab }).click();
  if (tab === 'Keys') await page.locator('.row[data-row="7"] .name').click();
  await page.waitForTimeout(500);
  // passed as a string so the bundler doesn't rewrite the function that runs in the page
  const r = (await page.evaluate(`new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const start = last;
    const tick = (now) => {
      gaps.push(now - last);
      last = now;
      if (now - start < 5000) requestAnimationFrame(tick);
      else resolve({
        fps: Math.round((gaps.length / (now - start)) * 10000) / 10,
        worst: Math.round(Math.max(...gaps) * 10) / 10,
        over20: gaps.filter((g) => g > 20).length,
        frames: gaps.length,
      });
    };
    requestAnimationFrame(tick);
  })`)) as { fps: number; worst: number; over20: number; frames: number };
  const load = await page.locator('.lcd .info div:nth-child(3) b').textContent().catch(() => '');
  console.log(`${tab.padEnd(6)} ${r.fps} fps over ${r.frames} frames, worst frame ${r.worst} ms, ${r.over20} frames over 20 ms, audio load ${load}`);
  if (r.fps < 55) slow = true;
}
await b.close();
if (slow) console.error('FAIL: under 55 frames a second on at least one screen');
process.exit(slow ? 1 : 0);
