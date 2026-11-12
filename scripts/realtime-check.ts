// Drives tests/realtime in headless Chromium against the Vite dev server.
// Run with: npx tsx scripts/realtime-check.ts

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
let code = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('http://localhost:5199/tests/realtime/');
  await page.waitForFunction(() => (window as any).__result, null, { timeout: 60000 });
  const r = await page.evaluate(() => (window as any).__result);
  console.log(r);
  if (r.error || r.worstErrorFrames !== 0 || r.steps < r.expectedSteps - 2 || r.underruns > 0) {
    console.error('FAIL: steps did not land on their exact frames, or audio dropped out');
    code = 1;
  } else {
    console.log(`OK: ${r.steps} steps, all on their exact frame and no dropouts, through ${r.mainThreadFreezes} main-thread freezes of up to ${r.longestFreezeMs}ms`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
