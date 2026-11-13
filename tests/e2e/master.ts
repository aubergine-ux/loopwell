// End-to-end check of the mastering assistant against the production build.
// Run with: npm run test:master   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { integratedLoudness, samplePeak } from '../../src/core/loudness';
import { decodeWav } from '../../src/core/wav';

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
async function exportWav(page: Page): Promise<{ lufs: number; peakDb: number }> {
  await page.getByTitle(/^Export WAV/).click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }) as Promise<Download>, page.locator('.modal .audio > button').click()]);
  const w = decodeWav(new Uint8Array(readFileSync((await d.path())!)));
  return { lufs: integratedLoudness(w.channels[0], w.channels[1], w.sampleRate), peakDb: 20 * Math.log10(samplePeak(w.channels[0], w.channels[1])) };
}
const meter = (page: Page) => page.locator('.lcd .vu i').first().evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));

const b = await launch();
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');
  const raw = await exportWav(page);

  await tab(page, 'Master');
  check('mastering is off until asked for', (await page.getByRole('button', { name: 'Mastering on/off' }).textContent()) === 'OFF' && (await page.getByRole('button', { name: 'Compare with before' }).isDisabled()));
  await page.getByLabel('Mastering style').selectOption({ label: 'House' });
  check('choosing a style switches it on and sets the chain up', (await page.getByRole('button', { name: 'Mastering on/off' }).textContent()) === 'ON'
    && (await page.getByLabel('Loudness to aim for, in LUFS').inputValue()) === '9' && (await page.getByRole('slider', { name: 'Width' }).getAttribute('aria-valuenow')) === '84');
  await page.getByRole('button', { name: 'Set loudness' }).click();
  await page.waitForFunction(() => /Mastered to|As loud as/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 60000 });
  const said = (await page.locator('.toast').textContent()) ?? '';
  check('the assistant measures the song and sets the gain', /^Mastered to -(8\.\d|9\.\d) LUFS \(it was -\d+\.\d\), with peaks at -1\.\d dB/.test(said), said);
  await shot(page, 'master');
  const done = await exportWav(page);
  check('an export of the mastered song is at the target loudness', Math.abs(done.lufs + 9) < 0.7, `${done.lufs.toFixed(2)} LUFS (unmastered: ${raw.lufs.toFixed(2)})`);
  check('with no sample above -1 dB', done.peakDb <= -0.95, `${done.peakDb.toFixed(2)} dB`);

  // a different target
  await page.getByLabel('Loudness to aim for, in LUFS').selectOption('14');
  await page.getByRole('button', { name: 'Set loudness' }).click();
  await page.waitForFunction(() => /Mastered to -1[34]/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 60000 });
  const quiet = await exportWav(page);
  check('aiming for -14 gives -14', Math.abs(quiet.lufs + 14) < 0.7, `${quiet.lufs.toFixed(2)} LUFS`);

  // live: meters move, compare swaps, and leaving the panel swaps back
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.getByRole('slider', { name: 'Gain' }).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowUp');
  let lim = 0;
  for (let i = 0; i < 25; i++) { lim = Math.max(lim, await page.locator('.gr.lim i').evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0))); await page.waitForTimeout(60); }
  check('pushed hard, the limiter meter shows it working', lim > 0.05, `${lim}`);
  let on = 0, off = 0;
  for (let i = 0; i < 20; i++) { on = Math.max(on, await meter(page)); await page.waitForTimeout(50); }
  await page.getByRole('button', { name: 'Compare with before' }).click();
  await page.waitForTimeout(3200); // the match is made on the last three seconds
  for (let i = 0; i < 20; i++) { off = Math.max(off, await meter(page)); await page.waitForTimeout(50); }
  check('"before" plays at about the same level, so the comparison is fair', (await page.getByRole('button', { name: 'Hearing: before' }).getAttribute('aria-pressed')) === 'true' && off > on * 0.6 && off < on * 1.6, `mastered ${on}, before ${off}`);
  await tab(page, 'Mix');
  await tab(page, 'Master');
  check('leaving the panel puts the mastered sound back', (await page.getByRole('button', { name: 'Compare with before' }).getAttribute('aria-pressed')) === 'false');
  await page.keyboard.press('Space');

  // it travels, and it undoes
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.cell');
  await page.waitForTimeout(400);
  await page.keyboard.press('Space').catch(() => {});
  await tab(page, 'Master');
  check('a share link carries the mastering', (await page.getByRole('button', { name: 'Mastering on/off' }).textContent()) === 'ON' && (await page.getByLabel('Loudness to aim for, in LUFS').inputValue()) === '14');

  // nothing to measure
  await page.keyboard.press('Control+k');
  await page.keyboard.type('new beat');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowRight');
  await tab(page, 'Master');
  await page.getByRole('button', { name: 'Set loudness' }).click();
  const nothing = await page.waitForFunction(() => /nothing playing to measure/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 30000 }).then(() => true, () => false);
  check('an empty pattern is not "mastered": it says there is nothing to measure', nothing && (await page.getByRole('button', { name: 'Mastering on/off' }).textContent()) === 'OFF', (await page.locator('.toast').textContent().catch(() => '')) ?? '');

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
