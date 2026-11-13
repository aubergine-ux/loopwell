// End-to-end check of stem separation, with the real model: it downloads HT-Demucs (about 180 MB) and runs it,
// so this takes minutes and is not part of the default test run or of CI.
// Run with: npm run test:stems   (set SHOTS=dir to keep screenshots)

import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { encodeWav } from '../../src/core/wav';

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results[results.length - 1]);
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

// A small "song" with parts that are easy to tell apart afterwards: a kick and a noisy snare, and a bass line.
// Returned with the two parts on their own, to compare the stems against.
const SR = 44100, SECONDS = 9;
function song(): { mix: Float32Array; drums: Float32Array; bass: Float32Array } {
  const n = SR * SECONDS;
  const drums = new Float32Array(n), bass = new Float32Array(n);
  let seed = 9;
  const noise = () => { seed = (seed * 1103515245 + 12345) | 0; return seed / 2147483648; };
  const beat = SR / 2; // 120 bpm
  for (let b = 0; b * beat < n; b++) {
    const at = Math.round(b * beat);
    for (let i = 0; i < 9000 && at + i < n; i++) {
      const t = i / SR;
      drums[at + i] += b % 2 === 0
        ? Math.sin(2 * Math.PI * (50 + 110 * Math.exp(-t * 28)) * t) * Math.exp(-t * 9) * 0.8 // kick
        : noise() * Math.exp(-t * 22) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.3; // snare
    }
    for (let i = 0; i < 1500 && at + beat / 2 + i < n; i++) drums[at + Math.round(beat / 2) + i] += noise() * Math.exp(-i / 250) * 0.25; // hat
  }
  const line = [41, 41, 44, 39, 41, 46, 44, 39];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / beat), f = 440 * Math.pow(2, (line[k % line.length] - 69) / 12);
    ph += (2 * Math.PI * f) / SR;
    const e = Math.min(1, ((i % beat) / SR) * 200) * Math.exp(-((i % beat) / SR) * 2.5);
    bass[i] = (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)) * 0.45 * e;
  }
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = drums[i] + bass[i];
  return { mix, drums, bass };
}

const b = await launch();
const { page, url } = b;
page.setDefaultTimeout(60000);
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  const { mix, drums, bass } = song();

  await page.keyboard.press('Control+k');
  await page.keyboard.type('split a song');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dropzone');
  check('the dialog opens with a plain note about rights', (await page.locator('.rights').textContent())!.includes('Only split music you have the right to use'));
  check('the heavy parts are not loaded until asked for', await page.evaluate(() => !performance.getEntriesByType('resource').some((r) => /ort-wasm|worker-/.test(r.name))));

  await page.locator('.modal input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('words') });
  check('a file that is not audio is refused', ((await page.locator('.modal .error').textContent({ timeout: 5000 }).catch(() => '')) ?? '').includes('notes.txt'));
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'two tracks.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav([mix, mix], SR, 16)) });
  await page.waitForSelector('.src');
  check('an audio file is read and shown with its length', (await page.locator('.src .name').textContent())!.includes('two tracks') && (await page.locator('.src .name span').textContent()) === '0:09');
  await shot(page, 'stems-ready');

  const began = Date.now();
  await page.getByRole('button', { name: 'Split into stems' }).click();
  await page.waitForSelector('.progress');
  const stages = new Set<string>();
  let sawDownload = false, sawParts = false;
  for (;;) {
    if (await page.locator('.stems li').count()) break;
    // read in one go, without waiting for things that may not be on screen
    const [err, what, detail] = (await page.evaluate(`['.modal .error', '.progress .what b', '.progress .what span'].map((q) => document.querySelector(q)?.textContent ?? '')`)) as string[];
    if (err) throw new Error(`the split failed: ${err}`);
    if (what) stages.add(what.replace(/ \(.*/, ''));
    if (/ of \d+ MB/.test(detail)) sawDownload = true;
    if (/part \d+ of \d+/.test(detail)) sawParts = true;
    if (Date.now() - began > 20 * 60000) throw new Error('gave up after twenty minutes');
    await page.waitForTimeout(500);
  }
  const took = (Date.now() - began) / 1000;
  check('progress is shown for the download and for the split itself', sawDownload && sawParts && stages.has('Splitting'), `${[...stages].join(' → ')}; ${took.toFixed(0)} s in all`);
  const note = (await page.locator('.modal .small', { hasText: 'Done in' }).textContent()) ?? '';
  check('four stems come back, and it says what did the work', (await page.locator('.stems li').count()) === 4 && /Done in \d+ s on (WebGPU|WebAssembly)/.test(note), note.slice(0, 60));
  await shot(page, 'stems-done');

  // do the stems hold what they should? compare each with the parts the song was made from
  // (the page-side code is a string so that the test runner leaves it as written)
  await page.evaluate(({ d, bs }) => { (window as any).__parts = { d, bs }; }, { d: [...drums], bs: [...bass] });
  const quality = (await page.evaluate(`(async () => {
    const { d, bs } = window.__parts;
    const db = await new Promise((res) => { const r = indexedDB.open('loopwell'); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const r = db.transaction('samples').objectStore('samples').getAll(); r.onsuccess = () => res(r.result); });
    const ctx = new AudioContext();
    const corr = (x, y) => { let xy = 0, xx = 0, yy = 0; const n = Math.min(x.length, y.length); for (let i = 0; i < n; i++) { xy += x[i] * y[i]; xx += x[i] * x[i]; yy += y[i] * y[i]; } return xy / Math.sqrt(xx * yy + 1e-12); };
    const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
    const at = async (x) => { const o = new OfflineAudioContext(1, Math.round((x.length * ctx.sampleRate) / 44100), ctx.sampleRate); const bf = o.createBuffer(1, x.length, 44100); bf.copyToChannel(Float32Array.from(x), 0); const s = o.createBufferSource(); s.buffer = bf; s.connect(o.destination); s.start(); return (await o.startRendering()).getChannelData(0); };
    const dr = await at(d), ba = await at(bs);
    const out = {};
    for (const s of all) {
      const m = /^(drums|bass|other|vocals) /.exec(s.name);
      if (!m) continue;
      const buf = await ctx.decodeAudioData(s.bytes.buffer.slice(s.bytes.byteOffset, s.bytes.byteOffset + s.bytes.byteLength));
      const x = buf.getChannelData(0);
      out[m[1]] = { drums: +corr(x, dr).toFixed(3), bass: +corr(x, ba).toFixed(3), level: +rms(x).toFixed(4) };
    }
    return out;
  })()`)) as Record<string, { drums: number; bass: number; level: number }>;
  const q = JSON.stringify(quality);
  check('the drum stem is the drums and the bass stem is the bass', quality.drums?.drums > 0.8 && quality.bass?.bass > 0.8 && quality.drums.bass < 0.3 && quality.bass.drums < 0.3, q);
  check('and the stems that had nothing to find are close to silent', quality.vocals?.level < quality.drums.level * 0.25 && quality.other?.level < quality.drums.level * 0.35, q);

  // use them
  await page.getByRole('button', { name: 'Play the drums stem' }).click();
  await page.waitForFunction(() => /scaleX\((0\.[0-9]*[1-9]|1)/.test((document.querySelector('.lcd .vu i') as HTMLElement).style.transform), undefined, { timeout: 5000 });
  check('a stem can be auditioned', true);
  // by hand, the way a mouse does it: press on the stem, move off it, carry it to the track, let go
  const stem = (await page.locator('.stems li').nth(1).locator('b').boundingBox())!, target = (await page.locator('.row[data-row="5"] .cells').boundingBox())!;
  await page.mouse.move(stem.x + 10, stem.y + 8);
  await page.mouse.down();
  await page.mouse.move(stem.x + 20, stem.y + 18, { steps: 3 });
  await page.waitForTimeout(200);
  await page.mouse.move(target.x + 100, target.y + 10, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('dragging a stem onto a track puts it there', (await page.locator('.row[data-row="5"] .name b').textContent())!.startsWith('BASS (TWO') && (await page.locator('.modal').count()) === 0,
    (await page.locator('.row[data-row="5"] .name b').textContent()) ?? '');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('split a song');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.stems li');
  check('the results are still there when the dialog is opened again', (await page.locator('.stems li').count()) === 4);
  await page.locator('.stems li').first().getByRole('button', { name: /^Use on/ }).click();
  check('and "Use on" puts a stem on the selected track', (await page.locator('.row.sel .name b').textContent())!.startsWith('DRUMS (TWO'));
  await page.locator('.sampler').getByRole('button', { name: 'Browse' }).click();
  await page.locator('.filters').getByRole('button', { name: 'Imported' }).click();
  check('all four are in the sound library', (await page.locator('.browser .row').count()) === 4);
  await page.keyboard.press('Escape');

  // again, with the network gone: the model and the engine are kept from the first time
  await page.context().setOffline(true);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('split a song');
  await page.keyboard.press('Enter');
  const again = Date.now();
  await page.getByRole('button', { name: 'Split again' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Cancel' }).click();
  check('a split can be cancelled part-way', (await page.locator('.progress').count()) === 0 && (await page.getByRole('button', { name: 'Split into stems' }).count()) === 1);
  await page.getByRole('button', { name: 'Split into stems' }).click();
  await page.waitForSelector('.stems li', { timeout: 20 * 60000 });
  check('offline, a second split works from what was kept', true, `${((Date.now() - again) / 1000).toFixed(0)} s`);
  await page.context().setOffline(false);

  const real = b.errors.filter((e) => !/willReadFrequently|powerPreference|WebGPU|GPU/.test(e));
  check('no errors in the console', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1500));
} finally {
  await b.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
