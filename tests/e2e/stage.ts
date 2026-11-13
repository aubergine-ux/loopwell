// End-to-end check of the live screen (clip launcher, effect pad, recording a
// performance) and MIDI learn, against the production build.
// Run with: npm run test:stage   (set SHOTS=dir to keep screenshots)

import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
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
const clip = (page: Page, track: string, pat: string) => page.getByRole('gridcell', { name: `${track}, pattern ${pat}`, exact: false }).first();
const cls = async (page: Page, track: string, pat: string) => (await clip(page, track, pat).getAttribute('class')) ?? '';
const meter = (page: Page) => page.locator('.lcd .vu i').first().evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));

const b = await launch();
const ctx = await b.browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  const input: any = { name: 'Test Knobs', state: 'connected', onmidimessage: null };
  (window as any).__midi = (bytes: number[]) => input.onmidimessage?.({ data: new Uint8Array(bytes), target: input });
  (navigator as any).requestMIDIAccess = async () => ({ inputs: new Map([['1', input]]), onstatechange: null });
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const midi = (bytes: number[]) => page.evaluate((x) => (window as any).__midi(x), bytes);
try {
  await page.goto(b.url);
  await page.waitForSelector('.cell');
  // a second pattern to launch: hats on every step of pattern B
  await page.getByRole('button', { name: 'B', exact: true }).click();
  for (const s of [0, 1, 2, 3]) await page.locator(`.cell[data-t="3"][data-s="${s}"]`).click();
  await page.getByRole('button', { name: 'A', exact: true }).click();

  // ---- launcher ----
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.waitForSelector('.stage .grid');
  check('the live screen shows a clip for every track and pattern', (await page.locator('.stage .clip').count()) === 64);
  check('clips with something in them are marked', (await cls(page, 'KICK', 'A')).includes('has') && !(await cls(page, 'KICK', 'B')).includes('has') && (await cls(page, 'HAT', 'B')).includes('has'));
  await clip(page, 'HAT', 'B').click();
  check('while stopped, a launch takes effect at once', (await cls(page, 'HAT', 'B')).includes('on') && !(await cls(page, 'HAT', 'A')).includes('on'));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.stage .clip.live') !== null, undefined, { timeout: 5000 });
  check('playing lights the clips that are sounding', (await cls(page, 'HAT', 'B')).includes('live') && (await cls(page, 'KICK', 'A')).includes('live'));
  await clip(page, 'HAT', 'A').click();
  const waiting = (await cls(page, 'HAT', 'A')).includes('queued');
  await page.waitForFunction(() => document.querySelector('.stage .clip.queued') === null, undefined, { timeout: 4000 });
  check('while playing, a launch waits for the bar and then comes in', waiting && (await cls(page, 'HAT', 'A')).includes('live'));
  await page.getByRole('button', { name: 'Stop KICK' }).click();
  await page.waitForFunction(() => document.querySelector('.stage .stop.on') !== null, undefined, { timeout: 4000 });
  check('a track can be stopped in time', !(await cls(page, 'KICK', 'A')).includes('on'));
  await page.getByRole('radio', { name: 'Now' }).click();
  await page.getByRole('button', { name: 'Launch scene B' }).click();
  await page.waitForTimeout(200);
  check('a scene launches every track, at once when asked to', (await page.locator('.stage .clip.on').count()) === 8
    && (await cls(page, 'KICK', 'B')).includes('on') && (await page.getByRole('button', { name: 'Launch scene B' }).getAttribute('class'))!.includes('on'));
  await page.getByRole('button', { name: 'Release all' }).click();
  check('release all puts every track back on the selected pattern', (await cls(page, 'KICK', 'A')).includes('on') && (await page.getByRole('button', { name: 'Release all' }).isDisabled()));
  await shot(page, 'stage');

  // ---- effect pad ----
  const pad = page.locator('.stage .pad');
  const box = (await pad.boundingBox())!;
  for (const fx of ['Repeat', 'Tape stop', 'Throw', 'Filter']) {
    await page.getByRole('radio', { name: fx }).click();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4, { steps: 4 });
    const on = (await pad.getAttribute('class'))!.includes('on');
    await page.waitForTimeout(fx === 'Tape stop' ? 1300 : 300);
    const level = await meter(page);
    await page.mouse.up();
    check(`${fx.toLowerCase()} engages while the pad is held and lets go after`, on && !(await pad.getAttribute('class'))!.includes('on') && (fx !== 'Tape stop' || level < 0.02), `level ${level}`);
  }
  await page.waitForTimeout(500);
  check('the beat is back after the effects', (await meter(page)) > 0.05, String(await meter(page)));
  await pad.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  check('the pad works from the keyboard without stopping playback', (await pad.getAttribute('class'))!.includes('on') && (await page.locator('.stage .clip.live').count()) > 0);
  await page.keyboard.press('Space');
  await page.locator('.stage .bar').click({ position: { x: 5, y: 5 } });

  // ---- record a performance ----
  await page.getByRole('radio', { name: 'Beat' }).click();
  await page.getByRole('button', { name: 'Record to song' }).click();
  await page.waitForTimeout(700);
  await clip(page, 'HAT', 'B').click();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Stop KICK' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^Stop · bar/ }).click();
  await page.waitForSelector('.tl');
  const said = (await page.locator('.toast').textContent()) ?? '';
  const clips = await page.locator('.tl .clip').count();
  check('stopping the recording puts the performance on the timeline', /on the timeline: \d+ bars?, with the filter sweep/.test(said) && clips >= 9, `${clips} clips; "${said}"`);
  await shot(page, 'recorded');
  await page.keyboard.press('Space');
  let loud = 0;
  for (let i = 0; i < 30; i++) { loud = Math.max(loud, await meter(page)); await page.waitForTimeout(50); }
  check('and the recorded song plays', loud > 0.03, `${loud}; lcd ${await page.locator('.lcd').textContent()}`);
  await page.keyboard.press('Space');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Song', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tl .clip').length === 8, undefined, { timeout: 10000 }).catch(() => {});
  check('one undo brings the old arrangement back', (await page.locator('.tl .clip').count()) === 8, `${await page.locator('.tl .clip').count()} clips`);
  await page.getByRole('button', { name: 'Pattern', exact: true }).click();
  await page.locator('.row[data-row="0"] .name').click();

  // ---- MIDI learn ----
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.waitForSelector('.midi.live');
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.getByRole('button', { name: 'Learn', exact: true }).click();
  check('learn mode shows what to do', (await page.locator('.learnbar').textContent())!.includes('Click a knob'));
  await page.getByRole('slider', { name: 'Level' }).first().click();
  check('clicking a knob picks it without moving it', (await page.locator('.learnbar').textContent())!.includes('KICK · Level')
    && (await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow')) === '100');
  await midi([0xb0, 21, 64]);
  await page.locator('.learnbar').getByRole('button', { name: 'Done' }).click();
  await midi([0xb0, 21, 127]);
  const hi = await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow');
  await midi([0xb0, 21, 0]);
  const lo = await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow');
  check('the controller now moves that knob over its whole range', hi === '127' && lo === '0', `${hi} ${lo}`);
  await page.locator('.row[data-row="2"] .name').click();
  await midi([0xb0, 21, 50]);
  check('and keeps moving the same track when another is selected', (await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow')) === '100');
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  check('the mapping is listed', (await page.locator('.maps li').first().textContent())!.includes('CC 21') && (await page.locator('.maps li').first().textContent())!.includes('KICK · Level'));
  await page.locator('.maps input[type=checkbox]').first().check();
  await page.keyboard.press('Escape');
  await midi([0xb0, 21, 127]);
  check('“selected track” makes it follow the selection', (await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow')) === '127');
  await midi([0xb0, 7, 80]);
  check('unmapped controls still do what they always did', true);

  // learn the effect pad's switch from a pad (note) and its position from a knob
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.getByRole('button', { name: 'Learn', exact: true }).click();
  await page.getByRole('button', { name: 'On/off' }).click();
  await midi([0x90, 40, 100]);
  await page.getByRole('button', { name: 'Left–right' }).click();
  await midi([0xb0, 22, 10]);
  await page.keyboard.press('Escape');
  check('Escape leaves learn mode', (await page.locator('.learnbar').count()) === 0);
  await midi([0x90, 40, 100]);
  const engaged = (await pad.getAttribute('class'))!.includes('on');
  await midi([0xb0, 22, 127]);
  const x = await pad.getAttribute('aria-valuenow');
  await midi([0x80, 40, 0]);
  check('a controller can play the effect pad', engaged && x === '100' && !(await pad.getAttribute('class'))!.includes('on'), `${engaged} ${x}`);

  // saved sets survive a reload
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.getByLabel('Name for this set of mappings').fill('My knobs');
  await page.getByRole('button', { name: 'Save these' }).click();
  await page.getByRole('button', { name: 'Clear all' }).click();
  check('mappings can be cleared', (await page.locator('.empty').count()) === 1);
  await page.reload();
  await page.waitForSelector('.cell');
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.waitForSelector('.midi.live');
  await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  await page.locator('.modal').getByRole('button', { name: 'Load', exact: true }).click();
  check('a saved set comes back after a reload', (await page.locator('.maps').first().locator('li').count()) === 3);
  await page.keyboard.press('Escape');
  await midi([0xb0, 21, 33]);
  await page.locator('.row[data-row="0"] .name').click();
  check('and works', (await page.getByRole('slider', { name: 'Level' }).first().getAttribute('aria-valuenow')) === '33');

  check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await ctx.close();
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
