// End-to-end check of the vocal tools (pitch correction, harmony, chains, lyrics) against the production build.
// Run with: npm run test:vocal   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { decodeWav, encodeWav } from '../../src/core/wav';

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
async function download(page: Page, action: () => Promise<void>): Promise<Uint8Array> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }) as Promise<Download>, action()]);
  return new Uint8Array(readFileSync((await d.path())!));
}

// a held vowel, 40 cents flat of E4: one pulse per cycle through two resonances
const SR = 48000;
function vowel(note: number, seconds: number): Float32Array {
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  const f0 = 440 * Math.pow(2, (note - 69) / 12);
  const res = [700, 1200].map((f) => { const r = 0.985, w = (2 * Math.PI * f) / SR; return { a1: -2 * r * Math.cos(w), a2: r * r, y1: 0, y2: 0 }; });
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += f0 / SR;
    let x = 0;
    if (ph >= 1) { ph -= 1; x = 1; }
    let y = 0;
    for (const r of res) { const v = x - r.a1 * r.y1 - r.a2 * r.y2; r.y2 = r.y1; r.y1 = v; y += v; }
    out[i] = y * 0.05 * Math.min(1, i / 2000) * Math.min(1, (n - i) / 2000);
  }
  return out;
}
/** The pitch of a stretch of audio as a MIDI note. */
function pitchOf(x: Float32Array, sr: number, from: number, to: number): number {
  const a = Math.round(from * sr), n = Math.round((to - from) * sr);
  const c = (lag: number) => { let s = 0; for (let i = 0; i < n - lag; i += 2) s += x[a + i] * x[a + i + lag]; return s / (n - lag); };
  let best = 0, score = -Infinity;
  for (let lag = Math.floor(sr / 1000); lag <= Math.ceil(sr / 70); lag++) { const s = c(lag); if (s > score * 1.02) { score = s; best = lag; } }
  const y0 = c(best - 1), y1 = c(best), y2 = c(best + 1);
  return 69 + 12 * Math.log2(sr / (best + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2)) / 440);
}

const b = await launch();
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  // an empty pattern with the vocal on its first step, alone
  await page.keyboard.press('ArrowRight');
  await page.locator('.row[data-row="0"] .name').click();
  await tab(page, 'Sound');
  await page.locator('.sampler input[type=file]').setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav([vowel(63.6, 1.5)], SR, 16)) });
  await page.waitForFunction(() => document.querySelector('.row[data-row="0"] .name b')?.textContent === 'TAKE');
  await page.locator('.cell[data-t="0"][data-s="0"]').click();
  // C major, so the flat E has an E to be pulled to
  await tab(page, 'Keys');
  await page.getByLabel('Scale', { exact: true }).selectOption({ label: 'Major' });
  const render = async () => {
    await page.getByTitle(/^Export WAV/).click();
    const wav = decodeWav(await download(page, () => page.locator('.modal .audio > button').click()));
    return { x: wav.channels[0], sr: wav.sampleRate };
  };
  const dry = await render();
  check('the take plays as it was sung, a little flat', Math.abs(pitchOf(dry.x, dry.sr, 0.4, 0.9) - 63.6) < 0.08, pitchOf(dry.x, dry.sr, 0.4, 0.9).toFixed(2));

  // ---- pitch correction ----
  await tab(page, 'Rack');
  await page.getByRole('button', { name: 'Add Tune' }).click();
  check('Tune goes in the rack with its knobs, and says which key it works in', (await page.locator('.rack .fx').count()) === 1
    && (await page.locator('.rack .fx .knob').count()) === 4 && (await page.locator('.rack .fx small').textContent())!.startsWith('in C major'));
  const tuned = await render();
  const got = pitchOf(tuned.x, tuned.sr, 0.5, 1.0);
  check('with Tune on, the same take comes out on the note', Math.abs(got - 64) < 0.08, got.toFixed(2));
  await shot(page, 'tune');
  await page.getByRole('button', { name: 'Tune on/off' }).click();
  const off = await render();
  check('switched off, it is flat again', Math.abs(pitchOf(off.x, off.sr, 0.4, 0.9) - 63.6) < 0.08);
  await page.getByRole('button', { name: 'Tune on/off' }).click();
  // another key: in C sharp major the nearest note is D sharp
  await tab(page, 'Keys');
  await page.getByLabel('Key', { exact: true }).selectOption({ label: 'C♯' });
  const moved = await render();
  check('it follows the song\'s key', Math.abs(pitchOf(moved.x, moved.sr, 0.5, 1.0) - 63) < 0.08, pitchOf(moved.x, moved.sr, 0.5, 1.0).toFixed(2));
  await page.getByLabel('Key', { exact: true }).selectOption({ label: 'C' });

  // ---- harmony and formant ----
  await tab(page, 'Rack');
  await page.getByRole('button', { name: 'Add Harmony' }).click();
  await page.getByRole('button', { name: 'Add Formant' }).click();
  check('harmony and formant can be added after it', (await page.locator('.rack .fx').count()) === 3 && (await page.locator('.rack .fx').nth(2).locator('.knob').count()) === 3);
  const rich = await render();
  let rmsDry = 0, rmsRich = 0;
  for (let i = 24000; i < 40000; i++) { rmsDry += tuned.x[i] ** 2; rmsRich += rich.x[i] ** 2; }
  check('a harmony voice adds to the sound', rmsRich > rmsDry * 1.08, `${Math.sqrt(rmsRich / rmsDry).toFixed(2)}x`);

  // ---- chains ----
  for (const [name, count] of [['Clean', 3], ['Trap', 5], ['Lo-fi', 4], ['Radio', 3]] as const) {
    await page.getByLabel('Vocal chain').selectOption({ label: name });
    const n = await page.locator('.rack .fx').count();
    await page.keyboard.press('Space');
    await page.waitForSelector('.cell.ph');
    let loud = 0;
    for (let i = 0; i < 14; i++) { loud = Math.max(loud, await page.locator('.row[data-row="0"] .meter i').evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0))); await page.waitForTimeout(60); }
    await page.keyboard.press('Space');
    check(`the ${name} chain sets up ${count} effects and plays`, n === count && loud > 0.03, `${n} effects, level ${loud}`);
  }
  await shot(page, 'vocal-chain');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('a chain is one undo', (await page.locator('.rack .fx').count()) === 4, `${await page.locator('.rack .fx').count()}`);

  // ---- lyrics ----
  await tab(page, 'Lyrics');
  check('the lyrics pad starts with an explanation', (await page.locator('.lyrics p').textContent())!.includes('one line at a time'));
  await page.getByRole('button', { name: 'Paste lines…' }).click();
  await page.getByLabel('Lines to add').fill('Up before the sun\n\n  Nothing in my way  \nRunning on the one\nHear me when I say');
  await page.getByRole('button', { name: 'Add these lines' }).click();
  const at = await page.locator('.lyrics .at').allTextContents();
  check('pasted lines go in a bar apart, blank ones dropped', JSON.stringify(at) === '["1.1.1","2.1.1","3.1.1","4.1.1"]' && (await page.locator('.lyrics .text').nth(1).inputValue()) === 'Nothing in my way', JSON.stringify(at));
  await page.locator('.lyrics .text').nth(3).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('One more for the road');
  check('Enter in a line starts the next one a bar later', (await page.locator('.lyrics li').count()) === 5 && (await page.locator('.lyrics .at').nth(4).textContent()) === '5.1.1');
  // play the song: a five-bar timeline at a quick tempo
  await page.locator('.lcd .num').focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowUp');
  await page.locator('.seg.view').getByRole('button', { name: 'Song', exact: true }).click();
  const clip = page.locator('.clip').first();
  await page.keyboard.press('Shift');
  await clip.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  await tab(page, 'Lyrics');
  await page.keyboard.press('Space');
  const seen: string[] = [];
  for (let i = 0; i < 70 && seen.length < 4; i++) {
    const cur = (await page.locator('.prompter b').textContent()) ?? '';
    if (cur && seen[seen.length - 1] !== cur) seen.push(cur);
    await page.waitForTimeout(80);
  }
  check('while the song plays, the line being sung is shown and they go by in order', JSON.stringify(seen.slice(0, 3)) === '["Up before the sun","Nothing in my way","Running on the one"]', JSON.stringify(seen));
  check('and it is marked in the list', (await page.locator('.lyrics li.now').count()) === 1);
  await shot(page, 'lyrics');
  // pin a line to the moment it is sung
  // (the song is in its third bar or later by now, so the first line moves to after the second)
  await page.locator('.lyrics .at').nth(0).click();
  const pinned = await page.locator('.lyrics li').evaluateAll((els) => els.map((e) => (e.querySelector('.text') as HTMLInputElement).value));
  await page.keyboard.press('Space');
  check('pressing a line\'s position while it plays pins it there, and the lines stay in order', pinned.indexOf('Up before the sun') >= 2 && pinned[0] === 'Nothing in my way' && pinned.length === 5, pinned.join(' / '));

  // ---- it all travels ----
  await tab(page, 'Rack');
  const rackWas = await page.locator('.rack .fx header b').allTextContents();
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.keyboard.press('Escape');
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.tl, .cell');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space').catch(() => {});
  await tab(page, 'Lyrics');
  const back = await page.locator('.lyrics li').evaluateAll((els) => els.map((e) => (e.querySelector('.text') as HTMLInputElement).value));
  check('a share link carries the lyrics', JSON.stringify(back) === JSON.stringify(pinned), back.join(' / '));
  await tab(page, 'Rack');
  const names = await page.locator('.rack .fx header b').allTextContents();
  check('and the vocal rack', names.length > 0 && JSON.stringify(names) === JSON.stringify(rackWas), names.join(', '));

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
