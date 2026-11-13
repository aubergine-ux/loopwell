// End-to-end check of the video export against the production build: a real
// MP4 is made in the browser and then played back.
// Run with: npm run test:video   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

// how many different colours the preview has, and a fingerprint of it
const look = `(() => {
  const c = document.querySelector('.modal canvas');
  if (!c || !c.width) return { colours: 0, sum: 0, w: 0, h: 0 };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const seen = new Set(); let sum = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { seen.add((d[i] >> 3) + '-' + (d[i + 1] >> 3) + '-' + (d[i + 2] >> 3)); sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7; }
  return { colours: seen.size, sum, w: c.width, h: c.height };
})()`;
type Look = { colours: number; sum: number; w: number; h: number };

// play a file back in the page and report what it is
const watch = `(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error('the browser could not open the file')); });
  const c = document.createElement('canvas'); c.width = 160; c.height = Math.round(160 * v.videoHeight / v.videoWidth);
  const g = c.getContext('2d', { willReadFrequently: true });
  const frame = async (t) => {
    v.currentTime = t;
    await new Promise((ok) => { v.onseeked = ok; });
    g.drawImage(v, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0; const seen = new Set();
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7; seen.add((d[i] >> 4) + '-' + (d[i + 1] >> 4) + '-' + (d[i + 2] >> 4)); }
    return { sum, colours: seen.size };
  };
  const a = await frame(0.1), b = await frame(v.duration * 0.6);
  const tracks = v.audioTracks ? v.audioTracks.length : -1;
  return { w: v.videoWidth, h: v.videoHeight, seconds: v.duration, a, b, tracks, heard: v.webkitAudioDecodedByteCount };
})`;

async function make(page: Page): Promise<Uint8Array> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }) as Promise<Download>, page.getByRole('button', { name: 'Make the video' }).click()]);
  check(`the file is named after the beat (${d.suggestedFilename()})`, /\.mp4$/.test(d.suggestedFilename()));
  return new Uint8Array(readFileSync((await d.path())!));
}
const brands = (f: Uint8Array) => String.fromCharCode(...f.subarray(4, 8));
const has = (f: Uint8Array, word: string) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).includes(word);

const b = await launch();
const { page, url } = b;
try {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('.cell');
  const before = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /mediabunny|render-|VideoModal/.test(n)).length);
  check('nothing of the video maker is loaded until it is asked for', before === 0);
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');

  // found from the palette
  await page.keyboard.press('Control+k');
  await page.keyboard.type('video');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal canvas');
  await page.waitForFunction(() => !document.querySelector('.modal .wait'), undefined, { timeout: 60000 });
  await page.waitForTimeout(400);
  const tall = (await page.evaluate(look)) as Look;
  check('the preview draws the beat, tall by default', tall.colours > 4 && tall.h > tall.w, `${tall.w}×${tall.h}, ${tall.colours} colours`);
  await page.waitForTimeout(500);
  const later = (await page.evaluate(look)) as Look;
  check('and it moves', later.sum !== tall.sum);
  await shot(page, 'video-tall');

  for (const style of ['Spectrum', 'Pads', 'Cover art', 'Waveform']) {
    await page.getByRole('radio', { name: style, exact: true }).click();
    await page.waitForTimeout(250);
    const l = (await page.evaluate(look)) as Look;
    check(`${style} draws`, l.colours > 4, `${l.colours} colours`);
    await shot(page, `video-${style.toLowerCase().replace(' ', '-')}`);
  }

  // a square one, with a title and a tag
  await page.getByRole('radio', { name: /^Square/ }).click();
  await page.getByLabel('Title shown in the video').fill('Night bus');
  await page.getByLabel('Producer tag shown in the video').fill('prod. tester');
  await page.waitForTimeout(250);
  const sq = (await page.evaluate(look)) as Look;
  check('the preview follows the shape', sq.w === sq.h && sq.w > 0, `${sq.w}×${sq.h}`);
  await shot(page, 'video-square');
  const file = await make(page);
  check('it is an MP4', brands(file) === 'ftyp' && has(file, 'moov') && has(file, 'mdat'), `${(file.length / 1024).toFixed(0)} kB`);
  check('with a picture track and a sound track', has(file, 'vide') && has(file, 'soun'));
  const seen = (await page.evaluate(`${watch}(${JSON.stringify(Buffer.from(file).toString('base64'))})`)) as { w: number; h: number; seconds: number; a: { sum: number; colours: number }; b: { sum: number; colours: number }; tracks: number; heard: number };
  check('it plays back at 1080 × 1080', seen.w === 1080 && seen.h === 1080, `${seen.w}×${seen.h}`);
  check('it lasts as long as the pattern and its tail', seen.seconds > 1.5 && seen.seconds < 12, `${seen.seconds.toFixed(2)} s`);
  check('its frames have a picture in them, and it changes', seen.a.colours > 4 && seen.b.colours > 4 && seen.a.sum !== seen.b.sum, `${seen.a.colours} and ${seen.b.colours} colours`);
  await page.waitForFunction(() => /Video saved/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 10000 });
  check('the dialog closes when the video is saved', (await page.locator('.modal').count()) === 0);

  // the tag is remembered, and the wide shape comes from the Export dialog
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.locator('.modal button', { hasText: 'Video' }).first().click();
  await page.waitForSelector('.modal canvas');
  check('the producer tag is remembered', (await page.getByLabel('Producer tag shown in the video').inputValue()) === 'prod. tester');
  await page.getByRole('radio', { name: /^Wide/ }).click();
  await page.waitForFunction(() => !document.querySelector('.modal .wait'), undefined, { timeout: 60000 });
  const wide = await make(page);
  const w = (await page.evaluate(`${watch}(${JSON.stringify(Buffer.from(wide).toString('base64'))})`)) as { w: number; h: number };
  check('wide is 1920 × 1080', w.w === 1920 && w.h === 1080, `${w.w}×${w.h}`);

  // an empty beat has nothing to film
  await page.keyboard.press('Control+k');
  await page.keyboard.type('clear the whole pattern');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.cell.on'));
  await page.keyboard.press('Control+k');
  await page.keyboard.type('export a video');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal canvas');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await page.waitForSelector('.modal .error', { timeout: 30000 });
  check('a silent beat is refused with a reason', /nothing to film/.test((await page.locator('.modal .error').textContent()) ?? ''));
  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
  await shot(page, 'video-failed');
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
