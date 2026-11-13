// End-to-end check of the awkward cases: no network, files that are wrong or
// enormous, no mouse, and a small screen, for the parts of the app that load
// on demand. Run with: npm run test:edges

import type { Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { encodeWav } from '../../src/core/wav';

let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const palette = async (page: Page, what: string) => { await page.keyboard.press('Control+k'); await page.waitForSelector('.palette input'); await page.keyboard.type(what); await page.keyboard.press('Enter'); };
const toast = (page: Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.toast')?.textContent ?? ''), re.source, { timeout: 30000 });
const closeModal = async (page: Page) => { await page.getByRole('button', { name: 'Close' }).click(); await page.waitForFunction(() => !document.querySelector('.modal')); };
const meter = (page: Page) => page.locator('.lcd .vu i').first().evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));

const b = await launch();
const { page, url, errors } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  // let the service worker finish taking everything in
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.includes('precache')), undefined, { timeout: 60000 });
  await page.waitForTimeout(4000);

  // ---- no network ----
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForSelector('.cell', { timeout: 30000 });
  check('with no network, the app still opens', true);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  let top = 0;
  for (let i = 0; i < 20; i++) { top = Math.max(top, await meter(page)); await page.waitForTimeout(50); }
  check('and plays, kits and all', top > 0.05, `meter ${top.toFixed(2)}`);
  await page.keyboard.press('Space');
  for (const [what, sel] of [['export', '.modal .list'], ['learn lessons', '.modal .list'], ['shortcuts', '.modal'], ['export a video', '.modal canvas']] as const) {
    await palette(page, what);
    await page.waitForSelector(sel, { timeout: 15000 });
    await closeModal(page);
  }
  check('dialogs that load on demand open offline', true);
  await page.getByRole('button', { name: 'Song', exact: true }).click();
  await page.waitForSelector('.ruler', { timeout: 15000 });
  await page.getByRole('button', { name: 'Pattern', exact: true }).click();
  check('so does the song view', true);
  // a plugin that comes with the app
  await page.locator('.row[data-row="7"] .name').click();
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  await page.locator('.sound .seg button', { hasText: 'Plugin' }).click();
  await page.locator('.modal .plugin', { hasText: 'Pluck' }).click();
  await page.waitForFunction(() => { const btn = document.querySelector('.plugs .chain li .btn') as HTMLButtonElement | null; return !!btn && !btn.disabled; }, undefined, { timeout: 30000 });
  check('the built-in plugins load offline', (await page.locator('.plugs .chain li.bad').count()) === 0);
  // the community's list needs the network, and says so
  await page.locator('.plugs .add').click();
  await page.getByRole('button', { name: "Show the community's plugins" }).click();
  await page.waitForSelector('.modal [role="alert"]', { timeout: 20000 });
  check('what does need the network says so plainly', /could not be fetched/.test((await page.locator('.modal [role="alert"]').first().textContent()) ?? ''));
  await closeModal(page);
  // an export, entirely on the device
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator('.modal .list button', { hasText: 'DAW project' }).first().click()]);
  check('exports work offline', /\.dawproject$/.test(dl.suggestedFilename()));
  await page.context().setOffline(false);

  // ---- files that are wrong ----
  await page.locator('.row[data-row="0"] .name').click();
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  const input = page.locator('.sampler input[type=file]');
  await input.setInputFiles({ name: 'notes.wav', mimeType: 'audio/wav', buffer: Buffer.from('this is a text file wearing a wav hat') });
  await toast(page, /couldn.t|can.t|not.*audio|could not/i);
  check('a file that is not audio is refused, and the track keeps its sound', (await page.locator('.row[data-row="0"] .name b').textContent()) === 'KICK', (await page.locator('.toast').textContent()) ?? '');
  await input.setInputFiles({ name: 'empty.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(0) });
  await page.waitForTimeout(800);
  check('an empty file does no harm', (await page.locator('.row[data-row="0"] .name b').textContent()) === 'KICK');

  // ---- files that are enormous ----
  const sr = 44100;
  const song = (seconds: number) => {
    const n = sr * seconds, l = new Float32Array(n);
    for (let i = 0; i < n; i += 11025) for (let k = 0; k < 2000 && i + k < n; k++) l[i + k] = Math.sin(k * 0.05) * Math.exp(-k / 400) * 0.8;
    return Buffer.from(encodeWav([l, l], sr, 16));
  };
  const huge = song(180);
  await input.setInputFiles({ name: 'whole-album.wav', mimeType: 'audio/wav', buffer: huge });
  await toast(page, /too big \(25 MB max\)/);
  check(`a ${(huge.length / 1048576).toFixed(0)} MB file is turned away with the limit named`, (await page.locator('.row[data-row="0"] .name b').textContent()) === 'KICK');
  const big = song(115);
  const t0 = Date.now();
  await input.setInputFiles({ name: 'whole-song.wav', mimeType: 'audio/wav', buffer: big });
  await page.waitForFunction(() => document.querySelector('.row[data-row="0"] .name b')?.textContent === 'WHOLE-SONG', undefined, { timeout: 120000 });
  check(`a ${(big.length / 1048576).toFixed(0)} MB song can be dropped on a track`, true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.locator('.sound .seg button', { hasText: 'Slice' }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.waitForTimeout(600);
  check('and sliced, with the app still responding', (await page.locator('.cell.ph').count()) > 0);
  await page.keyboard.press('Space');
  await page.keyboard.press('Control+z');

  // ---- no mouse ----
  await palette(page, 'learn lessons');
  await page.waitForSelector('.modal .list');
  await page.keyboard.press('Tab');
  let guard = 0;
  while (guard++ < 12 && !(await page.evaluate(() => /Your first beat/.test(document.activeElement?.textContent ?? '')))) await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check('the lessons can be reached with Tab', await page.evaluate(() => /trap hi-hat/i.test(document.activeElement?.textContent ?? '')));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.card');
  check('and started with Enter', (await page.locator('.card header b').textContent()) === 'Straight eighths first');
  // the grid by keyboard: arrows move, Enter toggles
  await page.locator('.cell[data-t="3"][data-s="0"]').focus();
  for (let s = 0; s < 16; s += 2) { await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); }
  await page.waitForFunction(() => document.querySelector('.card header b')?.textContent === 'Hear it', undefined, { timeout: 15000 });
  check('a lesson step can be done from the keyboard', true);
  await page.locator('.card .btn', { hasText: 'End the lesson' }).focus();
  await page.keyboard.press('Enter');
  await palette(page, 'export a video');
  await page.waitForSelector('.modal canvas');
  await page.getByRole('radio', { name: /^Tall/ }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  check('the video dialog works from the keyboard', (await page.getByRole('radio', { name: /^Wide/ }).getAttribute('aria-checked')) === 'true');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  check('Escape closes it', true);

  // ---- a small screen ----
  await page.setViewportSize({ width: 360, height: 700 });
  const wide: string[] = [];
  for (const what of ['learn lessons', 'export a video', 'export', 'plugins', 'shortcuts', 'share']) {
    await palette(page, what);
    await page.waitForSelector('.modal');
    await page.waitForTimeout(400);
    const ok = await page.evaluate(() => { const m = document.querySelector('.modal')!.getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.modal .body *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 2 || getComputedStyle(el.parentElement!).overflowX !== 'visible' || el.closest('.face, textarea, pre') !== null); });
    if (!ok) wide.push(what);
    await closeModal(page);
  }
  check('the newer dialogs fit a 360-pixel phone', wide.length === 0, wide.join(', '));
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Live code').fill('kick: x*4\nhat: [x x x]*4');
  check('and so does the code editor', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|ERR_FAILED|decod/i.test(e));
  check('no errors on the page', real.length === 0, real.join(' | ').slice(0, 400));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message.split('\n').slice(0, 3).join(' ') : String(e));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
