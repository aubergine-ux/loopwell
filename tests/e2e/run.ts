// End-to-end smoke test against the production build in headless Chromium.
// Uses the app the way a person would: clicks, keys, files, links, MIDI.
// Run with: npm run test:e2e   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { encodeWav, decodeWav } from '../../src/core/wav';

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
let sharedLink = '';
const results: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const cell = (page: Page, t: number, s: number) => page.locator(`.cell[data-t="${t}"][data-s="${s}"]`);
const isOn = async (page: Page, t: number, s: number) => (await cell(page, t, s).getAttribute('class'))!.includes('on');
const pos = async (page: Page) => (await page.locator('.lcd .info div:nth-child(2) b').textContent()) ?? '';
// a link made by version 1.0 (Night Drive, from its README)
const V1_LINK = 'jU7BSsNAEJ1NtulisaTSQw7WNNBDkCIIgiaGsNskoDTEJSkeeh7RgicRD17iL_g9_Qk_wU9xNoh6ETrsW3jvMe8Nq2H4jqtkbcdreRSGYwF8eZ0twWsfpQQQvaZSdcG8Fg11eVYqbXXsBDz7Sq1sr02NNeU3uqi4d7swLOS6qLO-1yZSJnDKF6ppYH6WwvH4IOiiIl4WKmfpLIb5MIzKUl5UAoAxgjWoNvcPz9P8afNy1x-NSHpFRKBxXfq2W1Iwjn9enpP6RqksjnuWFaBD2CPssxkOLR8dYBHaLCFDomAFDpgkI8Hf8E-zjbhTwYRyJlTgU4FPOYd_C9R3QUaG7I7u5uPfXDMWiACFMJc6kQYnIUgtnHPCJSHVXw';
const toastText = (page: Page) => page.locator('.toast').textContent({ timeout: 4000 }).catch(() => '');

async function download(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Uint8Array }> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }) as Promise<Download>, action()]);
  return { name: d.suggestedFilename(), bytes: new Uint8Array(readFileSync((await d.path())!)) };
}

const b = await launch();
const { page, url } = b;
const ctx = page.context();

try {
// ---- first visit ----
await page.goto(url);
await page.waitForSelector('.cell');
check('starter beat is on the grid', (await isOn(page, 0, 0)) && (await isOn(page, 3, 2)) && !(await isOn(page, 1, 0)));
await shot(page, '01-first-visit');

// ---- playback ----
await page.keyboard.press('Space');
await page.waitForSelector('.cell.ph', { timeout: 5000 });
const pos1 = await page.locator('.lcd .info div:nth-child(2) b').textContent();
await page.waitForTimeout(700);
const pos2 = await page.locator('.lcd .info div:nth-child(2) b').textContent();
check('space starts playback and the playhead moves', pos1 !== pos2, `${pos1} -> ${pos2}`);
const master = await page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
check('audio reaches the master meter', /scaleX\(0\.[0-9]*[1-9]/.test(master) || master === 'scaleX(1.000)', master);
await page.keyboard.press('Space');
await page.waitForTimeout(200);
check('space stops playback', (await page.locator('.cell.ph').count()) === 0);

// ---- step editing ----
await cell(page, 1, 4).click();
check('clicking a step turns it on', await isOn(page, 1, 4));
await cell(page, 1, 4).click();
check('clicking again turns it off', !(await isOn(page, 1, 4)));
await cell(page, 1, 4).click();
const box = (await cell(page, 1, 4).boundingBox())!;
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 5 });
await page.mouse.up();
const label = await cell(page, 1, 4).getAttribute('aria-label');
check('dragging a step down lowers its velocity', /velocity (\d+)/.test(label!) && +/velocity (\d+)/.exec(label!)![1] < 60, label!);
// paint a row
const from = (await cell(page, 5, 0).boundingBox())!, to = (await cell(page, 5, 7).boundingBox())!;
await page.mouse.move(from.x + 5, from.y + 10);
await page.mouse.down();
await page.mouse.move(to.x + 5, to.y + 10, { steps: 16 });
await page.mouse.up();
let painted = 0;
for (let s = 0; s < 8; s++) if (await isOn(page, 5, s)) painted++;
check('dragging along a row paints steps', painted === 8, `${painted}/8`);

// ---- undo / redo ----
await page.waitForTimeout(500);
await page.keyboard.press('Control+z');
await page.waitForFunction(() => !document.querySelector('.cell[data-t="5"][data-s="3"]')?.classList.contains('on'), undefined, { timeout: 3000 }).catch(() => {});
check('undo reverts the last edit', !(await isOn(page, 5, 3)));
await page.keyboard.press('Control+Shift+z');
check('redo brings it back', await isOn(page, 5, 3));

// ---- keyboard ----
await cell(page, 7, 15).click(); // leaves focus on a step; Space must still mean play
await page.keyboard.press('Space');
await page.waitForSelector('.cell.ph', { timeout: 3000 }).catch(() => {});
check('space plays even when a step or button has focus', (await page.locator('.cell.ph').count()) > 0 && (await isOn(page, 7, 15)));
await page.keyboard.press('Space');
await cell(page, 7, 15).click();
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
check('arrow keys move the track selection', (await page.locator('.row.sel').getAttribute('data-row')) === '7');
await page.keyboard.press('ArrowUp');
await page.keyboard.press('KeyM');
check('M mutes the selected track', (await page.locator('.row[data-row="6"]').getAttribute('class'))!.includes('off'));
await page.keyboard.press('KeyM');
await page.keyboard.press('Equal');
check('= nudges the tempo', (await page.locator('.lcd .num').textContent()) === '121');
await page.keyboard.press('Minus');
await page.keyboard.press('BracketRight');
check('] switches panel', (await page.getByRole('tab', { name: 'Keys' }).getAttribute('aria-selected')) === 'true');
await page.keyboard.press('BracketLeft');
// record a synth line from the computer keyboard
await page.keyboard.press('KeyR');
await page.keyboard.press('Space');
await page.waitForSelector('.cell.ph');
for (const k of ['KeyA', 'KeyD', 'KeyG']) { await page.keyboard.down(k); await page.waitForTimeout(180); await page.keyboard.up(k); await page.waitForTimeout(120); }
await page.keyboard.press('Digit2');
await page.waitForTimeout(500);
await page.keyboard.press('Space');
await page.keyboard.press('KeyR');
let recNotes = 0, recHits = 0;
for (let s = 0; s < 16; s++) { if (await isOn(page, 6, s)) recNotes++; if (await isOn(page, 1, s)) recHits++; }
check('keys played while recording land in the pattern', recNotes === 3 && recHits >= 1, `${recNotes} notes, ${recHits} snare hits`);
await page.waitForTimeout(450);
for (let i = 0; i < 3 && ((await isOn(page, 6, 0)) || recNotes > 0); i++) { await page.keyboard.press('Control+z'); await page.waitForTimeout(50); recNotes = 0; for (let s = 0; s < 16; s++) if (await isOn(page, 6, s)) recNotes++; }

// ---- tracks ----
await page.locator('.row[data-row="7"] .name').click();
await page.getByRole('button', { name: 'Delete track' }).click();
check('a track can be deleted', (await page.locator('.row[data-row]').count()) === 7 && (await page.locator('.pad.empty').count()) === 1);
await page.locator('.row.add').getByRole('button', { name: 'Synth' }).click();
check('and a new one added', (await page.locator('.row[data-row]').count()) === 8);
await page.waitForTimeout(450);

// ---- 32 steps, patterns, themes ----
await page.getByRole('button', { name: '32', exact: true }).click();
check('32-step mode shows 32 cells per track', (await page.locator('.cell[data-t="0"]').count()) === 32);
await shot(page, '02-32-steps');
await page.getByRole('button', { name: '16', exact: true }).click();
await page.keyboard.press('ArrowRight');
check('pattern B is empty and selected', !(await isOn(page, 0, 0)) && (await page.getByTitle('Pattern B', { exact: true }).getAttribute('aria-pressed')) === 'true');
await page.keyboard.press('ArrowLeft');
for (const theme of ['night', 'slate', 'arcade', 'cream']) {
  await page.keyboard.press('Shift+C');
  const got = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'cream') await shot(page, `03-theme-${got}`);
}
check('theme cycles through all four', (await page.evaluate(() => document.documentElement.dataset.theme)) !== undefined);

// ---- synth + piano roll ----
await page.locator('.row[data-row="6"] .name').click();
await page.getByRole('tab', { name: 'Keys' }).click();
// the lane is taller than its scroll box, so aim inside the visible part
const view = (await page.locator('.roll .scroller').boundingBox())!;
const laneX = view.x + 46 + (view.width - 46) * (2.5 / 16), laneY = view.y + 100;
await page.mouse.click(laneX, laneY);
check('clicking the piano roll adds a note', (await page.locator('.note').count()) === 1 && (await isOn(page, 6, 2)));
const keys = await page.locator('.key').count();
await page.getByRole('button', { name: 'Scale lock' }).click();
const keysChromatic = await page.locator('.key').count();
check('scale lock hides out-of-key rows', keys < keysChromatic, `${keys} rows locked, ${keysChromatic} unlocked`);
await page.getByRole('button', { name: 'Scale lock' }).click();
await page.locator('.note').click();
check('clicking a note removes it', (await page.locator('.note').count()) === 0);
await page.mouse.click(laneX, laneY);
await shot(page, '04-piano-roll');

// ---- empty pattern ----
await page.keyboard.press('ArrowRight');
await page.getByTitle(/^Export WAV/).click();
await page.locator('.modal').getByRole('button', { name: /^Stems/ }).click();
await page.waitForFunction(() => /Nothing to export/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
check('exporting stems of an empty pattern explains itself', /Nothing to export/.test((await toastText(page)) ?? ''));
await page.keyboard.press('ArrowLeft');

// ---- sampler: slices, reverse, stretch ----
const meterNow = () => page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
// the meter moves a little later in some browsers than others, so look for a while rather than once
const sounded = async () => { for (let i = 0; i < 12; i++) { await page.waitForTimeout(60); if (!/scaleX\(0(\.0+)?\)/.test(await meterNow())) return true; } return false; };
await page.locator('.row[data-row="0"] .name').click();
await page.getByRole('tab', { name: 'Sound' }).click();
await page.waitForSelector('.wave canvas');
await page.getByRole('button', { name: 'Slice', exact: true }).click();
await page.waitForSelector('.mark');
check('turning a drum into a sliced track keeps its hits', (await isOn(page, 0, 0)) && (await isOn(page, 0, 4)) && (await page.locator('.mark').count()) >= 1);
await page.locator('.tools .seg button', { hasText: /^8$/ }).click();
check('a sample can be cut into equal slices, which appear on the pads', (await page.locator('.mark').count()) === 8 && (await page.locator('.pad[data-slice]').count()) === 8);
await page.locator('.pad[data-slice="2"]').click();
check('a slice pad plays its slice', (await sounded()) && (await page.locator('.mark.cur b').textContent()) === '3');
const wv = (await page.locator('.wave').boundingBox())!;
await page.mouse.dblclick(wv.x + wv.width * 0.03, wv.y + 20);
check('double-clicking the waveform adds a slice', (await page.locator('.mark').count()) === 9);
const m2 = (await page.locator('.mark').nth(2).boundingBox())!;
await page.mouse.move(m2.x + 6, m2.y + 30);
await page.mouse.down();
await page.mouse.move(m2.x + 46, m2.y + 30, { steps: 5 });
await page.mouse.up();
const m2b = (await page.locator('.mark').nth(2).boundingBox())!;
check('a slice marker can be dragged', m2b.x > m2.x + 25, `${m2.x.toFixed(0)} -> ${m2b.x.toFixed(0)}`);
await page.locator('.mark').nth(1).dblclick();
check('double-clicking a marker removes it', (await page.locator('.mark').count()) === 8);
await page.getByRole('button', { name: 'Auto', exact: true }).click();
await page.waitForTimeout(200);
const autoCount = await page.locator('.mark').count();
check('auto-slicing finds the hit in a one-shot', autoCount >= 1 && autoCount <= 3, `${autoCount} slices`);
await page.locator('.tools .seg button', { hasText: /^4$/ }).click();
await page.getByRole('tab', { name: 'Keys' }).click();
check('the piano roll of a sliced track has one row per slice', (await page.locator('.key').count()) === 4 && (await page.locator('.note').count()) === 4);
await page.keyboard.press('s');
check('the home row plays slices', await sounded());
await page.getByRole('tab', { name: 'Sound' }).click();
await page.getByRole('button', { name: 'Reverse' }).click();
check('reverse can be switched on', (await page.getByRole('button', { name: 'Reverse' }).getAttribute('aria-pressed')) === 'true');
await page.getByRole('button', { name: 'Reverse' }).click();
await page.getByRole('button', { name: 'Drum', exact: true }).click();
check('and back to a drum track, hits intact', (await isOn(page, 0, 0)) && (await page.locator('.pad[data-pad]').count()) === 8);

// ---- synth: presets, wavetables, modulation ----
await page.locator('.row[data-row="6"] .name').click();
await page.getByRole('button', { name: 'Presets' }).click();
await page.locator('.modal .groups button', { hasText: 'Lead' }).click();
await page.locator('.modal .load', { hasText: 'Super Saw' }).click();
check('a preset loads and plays a note', (await page.locator('.modal .load.on').textContent()) === 'Super Saw' && (await sounded()));
await page.locator('.modal .groups button', { hasText: 'Pad' }).click();
await page.locator('.modal .load', { hasText: 'Choir' }).click();
await page.getByLabel('Preset name').fill('my choir');
await page.getByRole('button', { name: 'Save as preset' }).click();
check('the current sound can be saved as a preset of your own', (await page.locator('.modal .groups button.on').textContent()) === 'Mine' && (await page.locator('.modal .load').allTextContents()).join() === 'my choir');
await page.keyboard.press('Escape');
check('the preset set up both oscillators, unison and the LFO', (await page.getByLabel('Oscillator 1 wave').inputValue()) === '6'
  && (await page.locator('.synth .stepper b').nth(1).textContent()) === '4' && (await page.getByLabel('LFO target').inputValue()) === '2');
await page.getByLabel('Oscillator 2 wave').selectOption('8');
await page.getByLabel('Mod envelope target').selectOption('3');
await page.keyboard.down('a');
await page.waitForTimeout(250);
const heldSound = await sounded();
await page.keyboard.up('a');
check('a two-oscillator wavetable sound plays from the keyboard', heldSound);

// ---- effect rack ----
await page.getByRole('tab', { name: 'Rack' }).click();
for (const n of ['EQ', 'Drive', 'Sidechain']) await page.getByRole('button', { name: `Add ${n}` }).click();
const rackOrder = () => page.locator('.fx header b').allTextContents();
check('effects can be added to a track', (await rackOrder()).join() === 'EQ,Drive,Sidechain' && /ducks when KICK plays/.test((await page.locator('.fx small').textContent())!));
const grip = (await page.locator('.fx').nth(2).locator('.grip').boundingBox())!;
const firstFx = (await page.locator('.fx').nth(0).boundingBox())!;
await page.mouse.move(grip.x + 4, grip.y + 6);
await page.mouse.down();
await page.mouse.move(firstFx.x + 60, firstFx.y + 40, { steps: 8 });
await page.mouse.up();
check('dragging an effect reorders the rack', (await rackOrder()).join() === 'Sidechain,EQ,Drive', (await rackOrder()).join());
await page.getByRole('button', { name: 'Move Sidechain later' }).click();
check('and so do its arrow buttons', (await rackOrder()).join() === 'EQ,Sidechain,Drive');
await page.getByRole('button', { name: 'Drive on/off' }).click();
await page.getByRole('button', { name: 'Remove EQ' }).click();
check('an effect can be bypassed or removed', (await rackOrder()).join() === 'Sidechain,Drive' && (await page.locator('.fx.off').count()) === 1);
await page.keyboard.press('7');
check('the track still sounds through its rack', await sounded());

// ---- recording from an input ----
await page.locator('.row[data-row="5"] .name').click();
await page.getByRole('tab', { name: 'Sound' }).click();
await page.locator('.kits .rec').click();
await page.waitForSelector('.rec.on', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
const recLabel = (await page.locator('.kits .rec').textContent()) ?? '';
await page.locator('.kits .rec').click();
await page.waitForFunction(() => document.querySelector('.row[data-row="5"] .name b')?.textContent === 'TAKE 1', null, { timeout: 5000 }).catch(() => {});
check('recording from the audio input lands on the track as a sample', /Stop \d/.test(recLabel)
  && (await page.locator('.row[data-row="5"] .name b').textContent()) === 'TAKE 1' && /take-1\.wav/.test((await page.locator('.wave .note').textContent()) ?? ''), recLabel);
await page.waitForSelector('.toast', { state: 'detached', timeout: 8000 }).catch(() => {});

// ---- pads view ----
await page.keyboard.press('p');
await page.waitForSelector('.perform .pad[data-pad]');
check('P opens the pads view, with a second bank for the selected track', (await page.locator('.perform .pad[data-pad]').count()) === 8 && (await page.locator('.cell').count()) === 0);
// this track has a slow, swelling sound by now, so hold the pads rather than tapping them
const hold = async (sel: string, n = 0) => {
  const box = (await page.locator(sel).nth(n).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.waitForTimeout(450);
  const heard = await sounded();
  await page.mouse.up();
  return heard;
};
check('a pad plays its track and selects it, bringing up its notes', (await hold('.perform .pad[data-pad="6"]')) && (await page.locator('.perform .pad.note').count()) === 8);
check('the note pads play up the scale', await hold('.perform .pad.note', 4));
await page.locator('.perform').getByRole('button', { name: 'Mute KICK' }).click();
check('tracks can be muted from the pads view', (await page.locator('.perform .pad[data-pad="0"].muted').count()) === 1);
await page.locator('.perform').getByRole('button', { name: 'Mute KICK' }).click();
const strip = (await page.locator('.touch').boundingBox())!;
await page.mouse.move(strip.x + strip.width * 0.5, strip.y + 20);
await page.mouse.down();
await page.mouse.move(strip.x + strip.width * 0.1, strip.y + 20, { steps: 4 });
const swept = await page.locator('.touch').getAttribute('aria-valuenow');
await page.mouse.up();
check('the touch strip sweeps the filter and springs back on release', +swept! < -40 && (await page.locator('.touch').getAttribute('aria-valuenow')) === '0', `${swept} -> ${await page.locator('.touch').getAttribute('aria-valuenow')}`);
await page.locator('.perform').getByRole('button', { name: 'Pattern C' }).click();
check('patterns can be switched there too', (await page.locator('.perform').getByRole('button', { name: 'Pattern C' }).getAttribute('aria-pressed')) === 'true');
await page.locator('.perform').getByRole('button', { name: 'Pattern A' }).click();
await page.keyboard.press('p');
await page.waitForSelector('.cell');

// ---- audio latency setting ----
await page.keyboard.press('Shift+Slash');
await page.locator('.modal').getByRole('radio', { name: 'lowest' }).click();
check('the latency setting is saved for next time', (await page.evaluate(() => localStorage.getItem('loopwell:latency'))) === 'lowest'
  && /takes effect when Loopwell is next opened/.test((await page.locator('.modal').textContent())!) && /Output latency right now: \d+ ms/.test((await page.locator('.modal').textContent())!));
await page.locator('.modal').getByRole('radio', { name: 'balanced' }).click();
await page.keyboard.press('Escape');

// ---- demos + share link ----
await page.getByTitle('Demo beats and new beat').click();
await page.getByText('Dust Loop').click();
await page.waitForSelector('.tl .play', { state: 'visible' });
check('a demo loads and plays on the timeline', (await page.locator('.lcd .num').textContent()) === '86' && (await page.locator('.clip').count()) === 16);
await shot(page, '05-demo-playing');
// the song is A A A B: by bar 4 the selected track has moved on to pattern B
await page.waitForFunction(() => document.querySelector('.lcd .info div:nth-child(2) b')?.textContent?.startsWith('4.'), null, { timeout: 12000 }).catch(() => {});
check('the song plays along the timeline and the display follows it', (await pos(page)).startsWith('4.') && (await page.getByTitle('Pattern B', { exact: true }).getAttribute('aria-pressed')) === 'true',
  await pos(page));

// ---- switching views while it plays ----
await page.getByRole('button', { name: 'Pattern', exact: true }).click();
await page.waitForSelector('.cell.ph', { timeout: 6000 }).catch(() => {});
const meterMid = await page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
check('switching to the pattern view keeps the music going', (await page.locator('.cell.ph').count()) > 0 && (await page.locator('.tbtn.play.on').count()) === 1 && meterMid !== 'scaleX(0.000)', meterMid);
// tapping a pattern while one loops queues it for the bar line
const swap = (await page.getByTitle('Pattern A', { exact: true }).getAttribute('aria-pressed')) === 'true' ? 'B' : 'A';
await page.getByTitle(`Pattern ${swap}`, { exact: true }).click();
const queuedNow = (await page.getByTitle(`Pattern ${swap}`, { exact: true }).getAttribute('class'))!.includes('queued');
await page.waitForFunction((o) => document.querySelector('.lcd .info b')?.textContent === o, swap, { timeout: 5000 }).catch(() => {});
check('a pattern change waits for the bar line, then loops that pattern', queuedNow && (await page.locator('.lcd .info b').first().textContent()) === swap);
await page.keyboard.press('v');
await page.waitForSelector('.tl .play', { state: 'visible', timeout: 6000 }).catch(() => {});
check('V switches back to the song, still playing', (await page.locator('.tl').count()) === 1 && (await page.locator('.tl .play').isVisible()));
await page.keyboard.press('Space');

// ---- arranging ----
const lane0 = (await page.locator('.lane.clips[data-lane="0"]').boundingBox())!;
const PX = 8; // pixels per step at the default zoom
const at = (step: number) => lane0.x + step * PX;
const midY = lane0.y + lane0.height / 2;
const layout = (t: number) => page.locator(`.lane.clips[data-lane="${t}"] .clip`).evaluateAll((els) =>
  els.map((e) => [Math.round(parseFloat((e as HTMLElement).style.left) / 8), Math.round(parseFloat((e as HTMLElement).style.width) / 8), e.querySelector('.pat')!.textContent]).sort((x, y) => +x[0]! - +y[0]!));
const drag = async (x0: number, y0: number, x1: number, y1: number, mods: string[] = []) => {
  await page.mouse.move(x0, y0);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
};
check('the old pattern chain shows up as clips', JSON.stringify(await layout(0)) === '[[0,48,"A"],[48,16,"B"]]', JSON.stringify(await layout(0)));
await page.mouse.dblclick(at(64 + 20), midY);
check('double-clicking a track adds a clip of the current pattern, snapped to the bar', JSON.stringify((await layout(0))[2]) === `[80,16,"${swap}"]`, JSON.stringify(await layout(0)));
await drag(at(80 + 8), midY, at(64 + 8), midY);
check('dragging a clip moves it', (await layout(0))[2][0] === 64, JSON.stringify(await layout(0)));
await drag(at(80) - 3, midY, at(96) - 3, midY);
check('dragging its edge stretches it, looping the pattern', JSON.stringify((await layout(0))[2].slice(0, 2)) === '[64,32]' && (await page.locator('.clip.on .rep').count()) === 1, JSON.stringify(await layout(0)));
await drag(at(64 + 8), midY, at(96 + 8), midY, ['Alt']);
check('Alt-dragging makes a copy', (await layout(0)).length === 4 && (await layout(0))[3][0] === 96, JSON.stringify(await layout(0)));
await page.keyboard.press('Control+d');
check('Ctrl+D duplicates the selected clip after itself', (await layout(0)).length === 5 && (await layout(0))[4][0] === 128, JSON.stringify(await layout(0)));
await page.keyboard.press('Delete');
check('Delete removes it', (await layout(0)).length === 4);
// drop a clip on top of the long first one: it splits around the newcomer
await drag(at(96 + 8), midY, at(16 + 8), midY);
check('a clip dropped on another one trims and splits it', JSON.stringify((await layout(0)).slice(0, 3).map((c) => c.slice(0, 2))) === '[[0,16],[16,32],[48,16]]', JSON.stringify(await layout(0)));
await page.keyboard.press('Control+z');
check('undo puts the arrangement back', (await layout(0))[0][1] === 48, JSON.stringify(await layout(0)));
const lane1 = (await page.locator('.lane.clips[data-lane="1"]').boundingBox())!;
await drag(at(96 + 8), midY, at(96 + 8), lane1.y + lane1.height / 2);
check('a clip can be dragged to another track', (await layout(0)).length === 3 && (await layout(1)).some((c) => c[0] === 96), JSON.stringify(await layout(1)));
await page.locator('.lane.clips[data-lane="1"] .clip').last().dblclick();
await page.waitForSelector('.cell');
check('double-clicking a clip opens its pattern in the pattern view',
  (await page.getByTitle(`Pattern ${swap}`, { exact: true }).getAttribute('aria-pressed')) === 'true' && (await page.locator('.row.sel[data-row="1"]').count()) === 1);
await page.getByRole('button', { name: 'Song', exact: true }).click();

// automation
await page.getByRole('button', { name: 'Add automation to KICK' }).click();
const curve = page.locator('svg.curve').first();
const cb = (await curve.boundingBox())!;
await page.mouse.move(cb.x + 2, cb.y + cb.height - 6);
await page.mouse.down();
for (let i = 1; i <= 24; i++) await page.mouse.move(cb.x + 2 + i * 16, cb.y + cb.height - 6 - i * 1.7, { steps: 2 });
await page.mouse.up();
const points = await curve.locator('circle').count();
check('dragging across an automation lane draws a curve', points >= 10 && /Level automation/.test((await curve.getAttribute('aria-label'))!), `${points} points`);
const c3 = (await curve.locator('circle').nth(3).boundingBox())!;
await drag(c3.x + 3, c3.y + 3, c3.x + 3, cb.y + 8);
const moved = (await curve.locator('circle').nth(3).boundingBox())!;
check('a point can be dragged', moved.y < c3.y - 5, `${c3.y.toFixed(0)} -> ${moved.y.toFixed(0)}`);
await page.mouse.dblclick(moved.x + 3, moved.y + 3);
check('double-clicking a point removes it', (await curve.locator('circle').count()) === points - 1);
await page.getByRole('combobox', { name: 'Automated knob' }).selectOption('filter');
check('a lane can be pointed at another knob', /Filter automation/.test((await curve.getAttribute('aria-label'))!));
await page.getByRole('combobox', { name: 'Automated knob' }).selectOption('vol');
await page.getByRole('button', { name: 'Add master automation' }).click();
check('the master has automation lanes too', (await page.locator('svg.curve').count()) === 2);
await page.getByRole('button', { name: 'Remove automation lane' }).last().click();

// markers, tempo, time signature
const ruler = (await page.locator('.ruler').boundingBox())!;
await page.mouse.click(ruler.x + 32 * PX + 2, ruler.y + 10);
await page.getByTitle('Add a marker at the cursor').click();
await page.getByLabel('Marker name').fill('hook');
await page.getByTitle('Change tempo at the cursor').click();
await page.getByLabel('Tempo from here').fill('172');
await page.getByLabel('Tempo from here').press('Enter');
await page.getByTitle(/^Change time signature/).click();
await page.getByLabel('Beats per bar').selectOption('3');
const flags = await page.locator('.flag').allTextContents();
check('markers, tempo changes and time signatures sit on the timeline', flags.join('|') === 'hook|♩ 172|3/4', flags.join('|'));
const barsAfter = await page.locator('.ruler b').evaluateAll((els) => els.slice(0, 5).map((e) => Math.round(parseFloat((e as HTMLElement).style.left) / 8)));
check('bar lines follow the time signature', JSON.stringify(barsAfter) === '[0,16,32,44,56]', JSON.stringify(barsAfter));
await page.locator('.flag.sig').click();
await page.getByRole('button', { name: 'Delete time signature' }).click();
check('a time signature can be removed again', (await page.locator('.flag.sig').count()) === 0);

// loop a section
await drag(ruler.x + 16 * PX, ruler.y + 10, ruler.x + 32 * PX, ruler.y + 10);
check('dragging along the ruler sets a loop', (await page.getByRole('button', { name: 'Loop', exact: true }).getAttribute('aria-pressed')) === 'true' && (await page.locator('.loop').count()) === 1);
await page.mouse.click(ruler.x + 16 * PX + 2, ruler.y + 10);
await page.keyboard.press('Space');
await page.waitForSelector('.tl .play', { state: 'visible' });
const seen = new Set<string>();
for (let i = 0; i < 24; i++) { seen.add((await pos(page)).split('.')[0]); await page.waitForTimeout(250); }
check('playback starts at the cursor and stays inside the loop', seen.size === 1 && seen.has('2'), [...seen].join(','));
await page.keyboard.press('Space');
await page.getByRole('button', { name: 'Loop', exact: true }).click();
await shot(page, '05b-timeline');

await page.getByRole('button', { name: 'Share' }).click();
const link = await page.locator('#share-url').inputValue();
check('a share link with the whole arrangement is still compact', link.includes('#b=') && link.length < 800, `${link.length} chars`);
await shot(page, '06-share');
sharedLink = link;
await page.keyboard.press('Escape');

const page2 = await ctx.newPage();
const errors2: string[] = [];
page2.on('pageerror', (e) => errors2.push(e.message));
await page2.goto(link);
await page2.waitForSelector('.tl .play', { state: 'visible', timeout: 8000 }).catch(() => {});
check('opening a share link loads the song and plays it immediately',
  (await page2.locator('.lcd .num').textContent()) === '86' && (await page2.locator('.tl .play').isVisible()) && errors2.length === 0);
check('the link carries the arrangement: clips, automation, marker and tempo change',
  (await page2.locator('.clip').count()) === (await page.locator('.clip').count()) && (await page2.locator('svg.curve circle').count()) === (await page.locator('svg.curve circle').count())
  && (await page2.locator('.flag').allTextContents()).join('|') === 'hook|♩ 172');
check('the link is cleared from the address bar after loading', !(await page2.evaluate(() => location.hash)));
await page2.keyboard.press('Space');

// ---- a link made by version 1.0 ----
await page2.goto('about:blank');
await page2.goto(`${url}#b=${V1_LINK}`);
await page2.waitForSelector('.tl .play', { state: 'visible', timeout: 8000 }).catch(() => {});
check('a link from version 1.0 still opens and plays, its chain laid out as clips',
  (await page2.locator('.lcd .num').textContent()) === '122' && (await page2.locator('.clip').count()) === 40 && (await page2.locator('.tl .play').isVisible()) && errors2.length === 0);
await page2.keyboard.press('Space');

// ---- bad links ----
for (const bad of ['#b=', '#b=!!!!', '#b=AAAAAAAA', `#b=${link.split('#b=')[1].slice(0, 40)}`, `#b=${'A'.repeat(50000)}`]) {
  await page2.goto(url + bad);
  await page2.waitForSelector('.device');
  const msg = await toastText(page2);
  await page2.waitForSelector('.toast', { state: 'detached', timeout: 8000 });
  if (!/damaged/.test(msg ?? '')) check(`bad link ${bad.slice(0, 16)}… is reported`, false, String(msg));
}
check('damaged links show an error and leave the app usable', errors2.length === 0 && (await page2.locator('.clip').count()) === 40, errors2.join('; '));
await page2.close();

// ---- exports ----
await page.getByTitle(/^Export WAV/).click();
const wav = await download(page, () => page.locator('.modal').getByRole('button', { name: /^WAV/ }).click());
const w = decodeWav(wav.bytes);
let peak = 0;
for (const x of w.channels[0]) peak = Math.max(peak, Math.abs(x));
check('WAV export is a real stereo render of the song', wav.name === 'dust-loop.wav' && w.channels.length === 2
  && w.channels[0].length > w.sampleRate * 10 && peak > 0.2, `${(w.channels[0].length / w.sampleRate).toFixed(1)}s, peak ${peak.toFixed(2)}`);
await page.waitForSelector('.busy', { state: 'detached' });

await page.getByTitle(/^Export WAV/).click();
const stems = await download(page, () => page.locator('.modal').getByRole('button', { name: /^Stems/ }).click());
const stemFiles = unzipSync(stems.bytes);
const stemNames = Object.keys(stemFiles);
check('stems export has one WAV per track with notes', stemNames.length === 8 && stemNames.every((n) => /^\d\d-[a-z0-9-]+\.wav$/.test(n))
  && decodeWav(stemFiles[stemNames[0]]).channels[0].length > w.sampleRate * 10, stemNames.join(' '));
await page.waitForSelector('.busy', { state: 'detached' });

await page.getByTitle(/^Export WAV/).click();
const mid = await download(page, () => page.locator('.modal').getByRole('button', { name: /^MIDI\s*Notes/ }).click());
check('MIDI export is a standard MIDI file', mid.name === 'dust-loop.mid' && String.fromCharCode(...mid.bytes.subarray(0, 4)) === 'MThd' && mid.bytes.length > 500);

check('MIDI export of a song carries its tempo change', [...mid.bytes].some((_, i) => mid.bytes[i] === 0xff && mid.bytes[i + 1] === 0x51 && i > 40));
await page.keyboard.press('v');
await page.waitForSelector('.cell');

// ---- dropping a file on a track ----
const dropped = [...encodeWav([Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 6) * 0.6 * (1 - i / 4000))], 22050, 16)];
await page.evaluate((bytes) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(bytes)], 'dropped-tom.wav', { type: 'audio/wav' }));
  const target = document.querySelector('.row[data-row="5"] .cells')!;
  for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}, dropped);
await page.waitForFunction(() => document.querySelector('.row[data-row="5"] .name b')?.textContent === 'DROPPED-TOM', null, { timeout: 5000 }).catch(() => {});
check('dropping an audio file on a track makes it that track\'s sample', (await page.locator('.row[data-row="5"] .name b').textContent()) === 'DROPPED-TOM'
  && (await page.locator('.drop').count()) === 0);

// ---- custom samples ----
const tone = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i * 0.2) * Math.exp(-i / 2000));
await page.locator('.row[data-row="0"] .name').click();
await page.getByRole('tab', { name: 'Sound' }).click();
await page.locator('.source input[type=file]').setInputFiles({ name: 'My Kick.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWav([tone], 44100, 16)) });
await page.waitForFunction(() => document.querySelector('.row[data-row="0"] .name b')?.textContent === 'MY KICK');
check('loading an audio file makes it the track sample', (await page.locator('.wave .note').textContent())!.includes('My Kick.wav'));

await page.locator('.source input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not audio') });
await page.waitForFunction(() => /notes\.txt/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 15000 }).catch(() => {});
check('a file that is not audio is rejected with a message', /Couldn't read notes\.txt/.test((await toastText(page)) ?? ''));
await page.locator('.source input[type=file]').setInputFiles({ name: 'empty.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(0) });
await page.waitForFunction(() => /empty/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
check('an empty file is rejected with a message', /is empty/.test((await toastText(page)) ?? ''));

await page.getByRole('button', { name: 'Share' }).click();
check('share dialog warns that custom samples do not travel in links', (await page.locator('.modal .note').textContent())!.includes('your own samples'));
const customLink = await page.locator('#share-url').inputValue();
await page.keyboard.press('Escape');

await page.getByTitle(/^Export WAV/).click();
const proj = await download(page, () => page.locator('.modal').getByRole('button', { name: /^Save project/ }).click());
check('project file bundles the custom sample', proj.name === 'dust-loop.loopwell' && Object.keys(unzipSync(proj.bytes)).some((n) => n.startsWith('samples/')));

// a different "device": fresh storage, so the custom sample is unknown there
const other = await b.browser.newContext({ viewport: { width: 1440, height: 900 } });
const page3 = await other.newPage();
const errors3: string[] = [];
page3.on('pageerror', (e) => errors3.push(e.message));
await page3.goto(customLink);
await page3.waitForSelector('.row[data-row="0"] .warn', { timeout: 8000 }).catch(() => {});
check('a link with a custom sample still opens, and flags the missing sound', (await page3.locator('.row[data-row="0"] .warn').count()) === 1 && errors3.length === 0);
await page3.keyboard.press('Space');
await page3.getByTitle(/^Export WAV/).click();
await page3.locator('.modal input[type=file]').setInputFiles({ name: proj.name, mimeType: 'application/zip', buffer: Buffer.from(proj.bytes) });
await page3.waitForFunction(() => /Opened/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
check('opening the project file on another device restores the beat and its sample',
  (await page3.locator('.row[data-row="0"] .name b').textContent()) === 'MY KICK' && (await page3.locator('.warn').count()) === 0);
await page3.getByTitle(/^Export WAV/).click();
await page3.locator('.modal input[type=file]').setInputFiles({ name: 'broken.loopwell', mimeType: 'application/zip', buffer: Buffer.from('nope') });
await page3.waitForFunction(() => /not a Loopwell project/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
check('a broken project file is rejected with a message', /not a Loopwell project/.test((await toastText(page3)) ?? '') && errors3.length === 0);

// ---- persistence ----
await page3.keyboard.press('Escape');
await page3.waitForTimeout(600);
await page3.reload();
await page3.waitForSelector('.cell');
await page3.waitForTimeout(600);
check('the beat and its custom sample survive a reload',
  (await page3.locator('.row[data-row="0"] .name b').textContent()) === 'MY KICK' && (await page3.locator('.warn').count()) === 0);

// ---- offline ----
await page3.evaluate(() => navigator.serviceWorker.ready);
await page3.waitForTimeout(1500);
await other.setOffline(true);
await page3.reload();
await page3.waitForSelector('.cell', { timeout: 8000 }).catch(() => {});
await page3.getByTitle('Demo beats and new beat').click();
await page3.getByRole('radio', { name: 'Demos' }).click(); // this browser has beats of its own by now, so the list opens on those
await page3.getByText('Glass Hours').click(); // a kit this page has never fetched
await page3.waitForSelector('.cell.ph', { timeout: 8000 }).catch(() => {});
await page3.waitForTimeout(1200);
const offMeter = await page3.locator('.row[data-row="0"] .meter i').evaluate((el) => (el as HTMLElement).style.transform);
check('works offline, including kits it has not loaded before', (await page3.locator('.cell.ph').count()) > 0 && /scaleX\(0\.[0-9]*[1-9]|scaleX\(1/.test(offMeter), offMeter);
await other.close();

// ---- MIDI ----
const midiCtx = await b.browser.newContext({ viewport: { width: 1440, height: 900 } });
await midiCtx.addInitScript(() => {
  const input: any = { name: 'Test Pads', state: 'connected', onmidimessage: null };
  (window as any).__midi = (bytes: number[]) => input.onmidimessage?.({ data: new Uint8Array(bytes) });
  (navigator as any).requestMIDIAccess = async () => ({ inputs: new Map([['1', input]]), onstatechange: null });
});
const page4 = await midiCtx.newPage();
await page4.goto(url);
await page4.waitForSelector('.cell');
await page4.getByRole('button', { name: 'MIDI' }).click();
await page4.waitForSelector('.midi.live');
check('MIDI controller connects and is listed', (await page4.getByRole('button', { name: 'MIDI' }).getAttribute('title'))!.includes('Test Pads'));
await page4.keyboard.press('r');
await page4.keyboard.press('Space');
await page4.waitForSelector('.cell.ph');
let before = 0;
for (let s = 0; s < 16; s++) if (await isOn(page4, 1, s)) before++;
for (let i = 0; i < 4; i++) {
  await page4.evaluate(() => (window as any).__midi([0x99, 37, 110])); // pad 2 on channel 10
  await page4.evaluate(() => (window as any).__midi([0x89, 37, 0]));
  await page4.waitForTimeout(260);
}
await page4.waitForTimeout(400);
let after = 0;
for (let s = 0; s < 16; s++) if (await isOn(page4, 1, s)) after++;
check('MIDI pad hits are recorded into the pattern', before === 0 && after >= 3, `${after} steps recorded`);
await page4.keyboard.press('r');
// keyboard notes on a synth track, held and released
await page4.locator('.row[data-row="6"] .name').click();
await page4.keyboard.press('r');
await page4.evaluate(() => (window as any).__midi([0x90, 49, 100])); // C#, out of key: should snap
await page4.waitForTimeout(400);
await page4.evaluate(() => (window as any).__midi([0x80, 49, 0]));
await page4.waitForTimeout(500);
await page4.keyboard.press('Space');
await page4.getByRole('tab', { name: 'Keys' }).click();
check('MIDI keyboard notes are recorded on the synth track', (await page4.locator('.note').count()) === 1);
await midiCtx.close();

// ---- tablet / touch ----
const tablet = await b.browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 });
const page5 = await tablet.newPage();
const errors5: string[] = [];
page5.on('pageerror', (e) => errors5.push(e.message));
await page5.goto(url);
await page5.waitForSelector('.pad');
await page5.locator('.pad[data-pad="2"]').tap();
check('tapping a pad on a touch screen selects and plays it', (await page5.locator('.pad[data-pad="2"]').getAttribute('class'))!.includes('sel') && errors5.length === 0);
await cell(page5, 4, 6).tap();
check('tapping a step on a touch screen toggles it', await isOn(page5, 4, 6));
const overflow = await page5.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check('tablet layout has no sideways page scroll', overflow <= 0, `${overflow}px`);
await shot(page5, '07-tablet');
await page5.setViewportSize({ width: 390, height: 844 });
await page5.waitForTimeout(300);
const overflowPhone = await page5.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check('phone layout has no sideways page scroll', overflowPhone <= 0, `${overflowPhone}px`);
await shot(page5, '08-phone');
await tablet.close();

} catch (e) {
  check('test script ran to the end', false, String(e).split('\n')[0]);
}

check('no errors or warnings in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
await b.close();

// ---- real-world autoplay policy and a slow connection ----
const strict = await launch({ autoplay: false });
try {
  const sp = strict.page;
  // samples take two seconds each to arrive
  await sp.route('**/kits/**', async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue(); });
  await sp.goto(strict.url + sharedLink.slice(sharedLink.indexOf('#'))); // same beat, on this run's server
  // Wait on this side: anything evaluated in the page counts as a user gesture and would unblock audio.
  await new Promise((r) => setTimeout(r, 4500));
  check('when the browser blocks autoplay, a shared beat waits behind one big play button', (await sp.locator('.gate').count()) === 1
    && (await sp.locator('.gate b').textContent()) === 'Dust Loop');
  await sp.locator('.gate').click();
  await sp.waitForSelector('.tl .play', { state: 'visible', timeout: 5000 }).catch(() => {});
  // the samples are held back two seconds here, so the first hits can take a moment: watch the meter for a while
  let m = '';
  for (let i = 0; i < 40; i++) {
    await sp.waitForTimeout(100);
    m = await sp.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
    if (!/scaleX\(0(\.0+)?\)/.test(m)) break;
  }
  check('one tap starts it, with sound, even on a slow connection', (await sp.locator('.gate').count()) === 0 && (await sp.locator('.tl .play').isVisible())
    && !/scaleX\(0(\.0+)?\)/.test(m) && m !== '', m);
  // Chrome itself logs one warning when it refuses to start audio; anything else is ours
  const real = strict.errors.filter((e) => !e.includes('AudioContext was not allowed to start'));
  check('no errors under the strict autoplay policy', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  check('strict-autoplay script ran to the end', false, String(e).split('\n')[0]);
}
await strict.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
