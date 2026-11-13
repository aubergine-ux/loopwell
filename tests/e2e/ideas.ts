// End-to-end check of "ideas to notes" (humming, tapping, MIDI import, loop fitting) against the production build.
// Run with: npm run test:ideas   (set SHOTS=dir to keep screenshots)

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { DEMOS } from '../../src/core/demos';
import { exportMidi } from '../../src/core/midi';
import { encodeWav } from '../../src/core/wav';

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const onSteps = (page: Page, t: number) => page.locator(`.cell.on[data-t="${t}"]`).evaluateAll((els) => els.map((e) => +(e as HTMLElement).dataset.s!));
const toast = (page: Page) => page.locator('.toast').textContent({ timeout: 6000 }).catch(() => '');

// what the made-up microphone will "sing": C D E-flat G in C minor, an octave below where the synth sits,
// a quarter, a quarter, a half and a quarter of a beat long at 120 bpm, after a second of quiet
const SR = 48000;
function sung(): Float32Array {
  const notes: [number, number][] = [[48, 0.19], [50, 0.19], [51, 0.44], [55, 0.19]];
  const out = new Float32Array(SR * 4);
  let at = SR, ph = 0;
  for (const [p, secs] of notes) {
    const n = Math.round(secs * SR), f = 440 * Math.pow(2, (p - 69) / 12);
    for (let i = 0; i < n; i++) {
      ph += (2 * Math.PI * f) / SR;
      out[at + i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * 0.3 * Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
    }
    at += n + Math.round(0.06 * SR);
  }
  return out;
}
function loopWav(bpm: number): Buffer {
  const sr = 44100, beat = (60 / bpm) * sr;
  const x = new Float32Array(Math.round(beat * 8));
  for (let b = 0; b < 16; b++) {
    const at = Math.round((b * beat) / 2);
    for (let i = 0; i < 3000 && at + i < x.length; i++) x[at + i] += b % 2 ? (((i * 7919) % 13) / 6.5 - 1) * Math.exp(-i / 200) * 0.4 : Math.sin(i * 0.02) * Math.exp(-i / 900);
  }
  return Buffer.from(encodeWav([x], sr, 16));
}
const dir = mkdtempSync(join(tmpdir(), 'loopwell-'));
const mic = join(dir, 'hum.wav');
writeFileSync(mic, encodeWav([sung()], SR, 16));

const b = await launch({ microphone: mic });
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');

  // ---- hum a melody ----
  await page.locator('.row[data-row="7"] .name').click();
  await page.getByRole('tab', { name: 'Keys', exact: true }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Hum' }).click();
  await page.waitForFunction(() => /Listening/.test(document.querySelector('.hum')?.textContent ?? ''), undefined, { timeout: 6000 });
  await shot(page, 'humming');
  await page.waitForTimeout(3600);
  await page.locator('.hum').click();
  const said = (await toast(page)) ?? '';
  await page.waitForTimeout(200);
  const notes = await page.locator('.note').evaluateAll((els) => els.map((e) => [(e as HTMLElement).style.left, (e as HTMLElement).style.width]));
  check('a hummed melody becomes notes', /4 notes from your melody, snapped to the key/.test(said) && notes.length === 4, `"${said}" ${notes.length} notes`);
  check('in time: on steps 1, 3, 5 and 9, the long one twice as long', JSON.stringify(await onSteps(page, 7)) === '[0,2,4,8]' && notes[2]?.[1] === '25%', JSON.stringify(notes));
  await shot(page, 'hummed');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('and one undo takes them away', (await page.locator('.note').count()) === 0);
  // the made-up microphone has finished its file: now there is nothing to hear
  await page.getByRole('button', { name: 'Hum' }).click();
  await page.waitForTimeout(900);
  await page.locator('.hum').click();
  // the message from the first hum may still be showing: wait for this one
  await page.waitForFunction(() => /heard/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 5000 }).catch(() => {});
  const none = (await toast(page)) ?? '';
  check('humming nothing says so and changes nothing', /No melody was heard|Nothing was heard/.test(none) && (await page.locator('.note').count()) === 0, `"${none}" ${await page.locator('.note').count()} notes`);
  await page.locator('.row[data-row="0"] .name').click();
  check('there is no hum button on a drum track', (await page.locator('.hum').count()) === 0);

  // ---- tap a rhythm ----
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await page.locator('.row[data-row="5"] .name').click();
  await page.getByRole('button', { name: 'Tap a rhythm' }).click();
  // at 120 bpm a step is 125 ms: taps on steps 1, 4, 7, 9 and 13, with the number key for this track
  const gaps = [375, 375, 250, 500];
  await page.keyboard.press('6');
  for (const g of gaps) { await page.waitForTimeout(g - 12); await page.keyboard.press('6'); }
  check('taps are counted as they come', (await page.locator('.tap.on').textContent())!.startsWith('5 tap'));
  await page.getByRole('button', { name: 'Done' }).click();
  const tapped = await onSteps(page, 5);
  check('a tapped rhythm lands on the steps it was tapped on', JSON.stringify(tapped) === '[0,3,6,8,12]', JSON.stringify(tapped));
  await page.getByLabel('Set the tempo from my taps').check();
  await page.getByRole('button', { name: 'Tap a rhythm' }).click();
  // four to the floor at 100 bpm: a tap every 600 ms
  for (let i = 0; i < 8; i++) { await page.locator('.tap.on').dispatchEvent('pointerdown'); if (i < 7) await page.waitForTimeout(588); }
  await page.waitForFunction(() => !document.querySelector('.tap.on'), undefined, { timeout: 5000 });
  const bpm = +(await page.locator('.lcd .num').textContent())!;
  const four = await onSteps(page, 5);
  check('with "set the tempo" the song takes the tempo that was tapped, and it finishes by itself', [50, 100, 200].some((x) => Math.abs(bpm - x) <= 3) && four.length >= 2 && four[0] === 0, `${bpm} bpm, steps ${JSON.stringify(four)}`);
  await page.getByRole('button', { name: 'Tap a rhythm' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  check('cancelling leaves the pattern as it was', JSON.stringify(await onSteps(page, 5)) === JSON.stringify(four));
  await shot(page, 'tap');

  // ---- fit a loop ----
  await page.locator('.row[data-row="4"] .name').click();
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  await page.locator('.sampler input[type=file]').setInputFiles({ name: 'break.wav', mimeType: 'audio/wav', buffer: loopWav(100) });
  await page.waitForSelector('.tools.loop', { timeout: 8000 });
  check('an imported loop is recognised, with its tempo and length', (await page.locator('.loop .found').textContent()) === '100 bpm · 2 bars', (await page.locator('.loop .found').textContent()) ?? '');
  await page.locator('.lcd .num').dblclick().catch(() => {});
  await page.getByRole('button', { name: /^Fit to \d+ bpm/ }).click();
  await page.waitForSelector('.mark');
  check('fitting it slices on the 8ths and writes the notes to play it', (await page.locator('.mark').count()) === 16 && JSON.stringify(await onSteps(page, 4)) === '[0,2,4,6,8,10,12,14]'
    && /cut into 16 slices and fitted to/.test((await toast(page)) ?? ''));
  await shot(page, 'loop-fit');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Song to 100 bpm' }).click();
  await page.waitForFunction(() => document.querySelector('.lcd .num')?.textContent === '100', undefined, { timeout: 4000 }).catch(() => {});
  check('or the song can take the loop\'s tempo', (await page.locator('.lcd .num').textContent()) === '100' && (await page.locator('.mark').count()) === 16);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  let loud = 0;
  for (let i = 0; i < 20; i++) { loud = Math.max(loud, await page.locator('.row[data-row="4"] .meter i').evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0))); await page.waitForTimeout(60); }
  check('and the sliced loop plays', loud > 0.05, `${loud}`);
  await page.keyboard.press('Space');
  await page.locator('.row[data-row="0"] .name').click();
  check('a single hit is not offered as a loop', (await page.locator('.tools.loop').count()) === 0);

  // ---- MIDI import ----
  const demo = DEMOS[1].make();
  const mid = Buffer.from(exportMidi({ ...demo, swing: 0 }));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'Dust Loop.mid', mimeType: 'audio/midi', buffer: mid });
  await page.waitForFunction((x) => document.querySelector('.lcd .num')?.textContent === x, String(demo.bpm), { timeout: 6000 });
  const opened = (await toast(page)) ?? '';
  check('a MIDI file opens as a beat at its own tempo', /^Opened “Dust Loop” from MIDI: \d tracks/.test(opened) && (await page.locator('.tl .clip').count()) > 4, opened);
  await shot(page, 'midi-import');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const level = await page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
  await page.keyboard.press('Space');
  check('and plays', /scaleX\((0\.[0-9]*[1-9]|1)/.test(level), level);
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'My beats' }).click();
  check('it arrived as a new beat, leaving the one that was open', (await page.locator('.beats li').count()) === 2 && (await page.locator('.beats li .open b').first().textContent()) === 'Dust Loop');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'broken.mid', mimeType: 'audio/midi', buffer: Buffer.from('not midi at all') });
  check('a file that is not MIDI is refused with a reason', ((await page.locator('.toast.error').textContent({ timeout: 4000 }).catch(() => '')) ?? '').includes('not a MIDI file'));

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
