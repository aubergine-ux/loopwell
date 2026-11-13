// Where the main thread's time goes while a busy beat plays, on a simulated tablet (CPU slowed four times):
// totals for layout, paint, script and so on over four seconds, for each panel named in TABS.
// Run with: npm run build && npx tsx scripts/frame-profile.ts

import { launch } from './_browser';
const b = await launch({ width: 1024, height: 768, touch: true, scale: 2 });
const { page } = b;
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(b.url);
await page.waitForSelector('.cell');
await page.getByTitle('Demo beats and new beat').click();
await page.getByText('Glass Hours').click();
await page.waitForSelector('.cell.ph');
for (const tab of (process.env.TABS ?? 'Sound,Mix').split(',')) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(800);
  const events: any[] = [];
  const collect = (e: any) => { events.push(...e.value); };
  cdp.on('Tracing.dataCollected', collect);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  await page.waitForTimeout(4000);
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.end');
  await done;
  const sum: Record<string, number> = {};
  for (const e of events) if (e.ph === 'X' && e.dur && ['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'FunctionCall', 'FireAnimationFrame', 'RasterTask', 'CompositeLayers', 'EventDispatch', 'TimerFire', 'RunMicrotasks', 'MajorGC', 'MinorGC', 'HitTest', 'IntersectionObserverController::computeIntersections', 'Animate'].includes(e.name)) sum[e.name] = (sum[e.name] ?? 0) + e.dur / 1000;
  console.log(tab, Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}ms`).join(', '));
  cdp.off('Tracing.dataCollected', collect);
}
await b.close();
process.exit(0);
