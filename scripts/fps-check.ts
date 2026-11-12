// Measures animation frame pacing while a busy 32-step beat plays.
// Run with: npm run build && npx tsx scripts/fps-check.ts

import { launch } from './_browser';

const b = await launch();
const { page } = b;
await page.goto(b.url);
await page.waitForSelector('.cell');
await page.getByTitle('Demo beats and new beat').click();
await page.getByText('Glass Hours').click();
await page.waitForSelector('.cell.ph');
for (const tab of ['Sound', 'Keys', 'Mix']) {
  await page.getByRole('tab', { name: tab }).click();
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
  console.log(`${tab.padEnd(6)} ${r.fps} fps over ${r.frames} frames, worst frame ${r.worst} ms, ${r.over20} frames over 20 ms`);
}
await b.close();
process.exit(0);
