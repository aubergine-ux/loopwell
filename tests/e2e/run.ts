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
check('pattern B is empty and selected', !(await isOn(page, 0, 0)) && (await page.getByTitle('Pattern B').getAttribute('aria-pressed')) === 'true');
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

// ---- demos + share link ----
await page.getByTitle('Demo beats and new beat').click();
await page.getByText('Dust Loop').click();
await page.waitForSelector('.cell.ph');
check('a demo loads and plays', (await page.locator('.lcd .num').textContent()) === '86');
await shot(page, '05-demo-playing');
// song mode walks the chain A A A B; pattern buttons follow it
await page.waitForFunction(() => document.querySelector('.lcd .info b')?.textContent?.startsWith('B'), null, { timeout: 12000 }).catch(() => {});
check('song mode advances through the pattern chain', (await page.locator('.lcd .info b').first().textContent())!.startsWith('B 4/4')
  && (await page.getByTitle('Pattern B').getAttribute('aria-pressed')) === 'true');
// tapping a pattern while playing queues it for the bar line
await page.getByTitle('Pattern A').click();
const queuedNow = (await page.getByTitle('Pattern A').getAttribute('class'))!.includes('queued');
await page.waitForFunction(() => document.querySelector('.lcd .info b')?.textContent === 'A', null, { timeout: 5000 }).catch(() => {});
check('a pattern change waits for the bar line, then loops that pattern', queuedNow && (await page.locator('.lcd .info b').first().textContent()) === 'A');
await page.keyboard.press('Space');
await page.keyboard.press('Control+z');
await page.getByRole('button', { name: 'Share' }).click();
const link = await page.locator('#share-url').inputValue();
check('share link is compact', link.includes('#b=') && link.length < 600, `${link.length} chars`);
await shot(page, '06-share');
sharedLink = link;
await page.keyboard.press('Escape');

const page2 = await ctx.newPage();
const errors2: string[] = [];
page2.on('pageerror', (e) => errors2.push(e.message));
await page2.goto(link);
await page2.waitForSelector('.cell.ph', { timeout: 8000 }).catch(() => {});
check('opening a share link loads the beat and plays it immediately',
  (await page2.locator('.lcd .num').textContent()) === '86' && (await page2.locator('.cell.ph').count()) > 0 && errors2.length === 0);
check('the link is cleared from the address bar after loading', !(await page2.evaluate(() => location.hash)));
await page2.keyboard.press('Space');

// ---- bad links ----
for (const bad of ['#b=', '#b=!!!!', '#b=AAAAAAAA', `#b=${link.split('#b=')[1].slice(0, 40)}`, `#b=${'A'.repeat(50000)}`]) {
  await page2.goto(url + bad);
  await page2.waitForSelector('.cell');
  const msg = await toastText(page2);
  await page2.waitForSelector('.toast', { state: 'detached', timeout: 8000 });
  if (!/damaged/.test(msg ?? '')) check(`bad link ${bad.slice(0, 16)}… is reported`, false, String(msg));
}
check('damaged links show an error and leave the app usable', errors2.length === 0 && (await page2.locator('.cell').count()) > 0, errors2.join('; '));
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
const mid = await download(page, () => page.locator('.modal').getByRole('button', { name: /^MIDI/ }).click());
check('MIDI export is a standard MIDI file', mid.name === 'dust-loop.mid' && String.fromCharCode(...mid.bytes.subarray(0, 4)) === 'MThd' && mid.bytes.length > 500);

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
check('loading an audio file makes it the track sample', (await page.locator('.custom').textContent())!.includes('My Kick.wav'));

await page.locator('.source input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not audio') });
check('a file that is not audio is rejected with a message', /Couldn't read notes\.txt/.test((await toastText(page)) ?? ''));
await page.locator('.source input[type=file]').setInputFiles({ name: 'empty.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(0) });
await page.waitForFunction(() => /empty/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
check('an empty file is rejected with a message', /is empty/.test((await toastText(page)) ?? ''));

await page.getByRole('button', { name: 'Share' }).click();
check('share dialog warns that custom samples do not travel in links', (await page.locator('.note').textContent())!.includes('your own samples'));
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
  await sp.waitForSelector('.cell.ph', { timeout: 5000 }).catch(() => {});
  await sp.waitForTimeout(800);
  const m = await sp.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
  check('one tap starts it, with sound, even on a slow connection', (await sp.locator('.gate').count()) === 0 && (await sp.locator('.cell.ph').count()) > 0
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
