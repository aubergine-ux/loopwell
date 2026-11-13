// End-to-end check of the workflow tools (command palette, history, shortcuts, the beat
// library and its versions, metronome, count-in, loop region) against the production build.
// Run with: npm run test:workflow   (set SHOTS=dir to keep screenshots)

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
const cell = (page: Page, t: number, s: number) => page.locator(`.cell[data-t="${t}"][data-s="${s}"]`);
const isOn = async (page: Page, t: number, s: number) => (await cell(page, t, s).getAttribute('class'))!.includes(' on');
const pos = async (page: Page) => (await page.locator('.lcd .info div:nth-child(2) b').textContent()) ?? '';
const beats = (page: Page) => page.locator('.beats li .open b').allTextContents();
const openBeats = async (page: Page) => { await page.getByRole('button', { name: 'Beats', exact: true }).click(); await page.getByRole('radio', { name: 'My beats' }).click(); };

const b = await launch();
const { page, url } = b;
try {
  // ---- someone who used Loopwell before the library existed ----
  // their browser has the old database (samples only) and one autosaved beat
  await page.goto(`${url}icon.svg`);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('loopwell', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('samples', { keyPath: 'id' });
      req.onsuccess = () => {
        const tx = req.result.transaction('samples', 'readwrite');
        tx.objectStore('samples').put({ id: 'user/abc1234', name: 'old.wav', bytes: new Uint8Array([1, 2, 3]) });
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
      req.onerror = () => reject(req.error);
    });
    // a 2.0 project: none of the newer settings in it
    localStorage.setItem('loopwell:project', JSON.stringify({
      v: 2, name: 'Old Faithful', bpm: 97, swing: 20, steps: 16,
      tracks: [{ name: 'KICK', kind: 'drum', color: 0, sample: 'boom/kick', vol: 100 }, { name: 'KEYS', kind: 'synth', color: 5, note: 60, synth: { wave: 1 } }],
      patterns: [{ steps: [[100, 0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0], []], notes: [[], [{ s: 2, l: 2, p: 64, v: 90 }]] }],
    }));
  });
  b.errors.length = 0; // the bare image used to set things up has no favicon; what matters is the app from here on
  await page.goto(url);
  await page.waitForSelector('.cell');
  check('a beat autosaved by 2.0 opens as it was', (await page.locator('.lcd .num').textContent()) === '97' && (await isOn(page, 0, 4)) && (await isOn(page, 1, 2))
    && (await page.locator('.row').count()) === 4);
  await page.waitForTimeout(1700);
  await openBeats(page);
  check('and becomes the first beat in the library', JSON.stringify(await beats(page)) === '["Old Faithful"]', JSON.stringify(await beats(page)));
  const kept = await page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open('loopwell');
    req.onsuccess = () => { const all = req.result.transaction('samples').objectStore('samples').getAll(); all.onsuccess = () => resolve(all.result.length); };
  }));
  check('samples stored by the old version are still there', kept === 1, `${kept}`);

  // ---- library ----
  await page.getByRole('button', { name: 'New beat' }).click();
  await page.waitForTimeout(300);
  check('a new beat starts fresh', (await page.locator('.lcd .num').textContent()) === '120' && (await page.locator('.row').count()) === 9);
  await cell(page, 5, 3).click();
  await page.waitForTimeout(1900);
  await openBeats(page);
  check('and the old one is still in the library, untouched', JSON.stringify(await beats(page)) === '["untitled","Old Faithful"]', JSON.stringify(await beats(page)));
  await page.getByRole('button', { name: 'Rename untitled' }).click();
  await page.getByLabel('New name for untitled').fill('Second Wind');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1700);
  check('a beat can be renamed', (await beats(page))[0] === 'Second Wind');
  await page.getByRole('button', { name: 'Duplicate Old Faithful' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.beats li').length === 3);
  check('and duplicated', (await beats(page)).includes('Old Faithful copy'));
  await page.getByRole('button', { name: 'Open: Old Faithful copy' }).click();
  await page.waitForFunction(() => document.querySelector('.lcd .num')?.textContent === '97');
  check('opening another beat switches to it', (await isOn(page, 0, 4)) && (await page.locator('.modal').count()) === 0);
  await cell(page, 0, 1).click();
  await page.waitForTimeout(1900);
  await openBeats(page);
  await page.getByRole('button', { name: 'Open: Second Wind' }).click();
  await page.waitForFunction(() => document.querySelector('.lcd .num')?.textContent === '120');
  check('each beat keeps its own changes', (await isOn(page, 5, 3)) && !(await isOn(page, 0, 1)));
  await page.reload();
  await page.waitForSelector('.cell');
  check('the beat that was open comes back after a reload', (await isOn(page, 5, 3)) && (await page.locator('.lcd .num').textContent()) === '120');
  await page.waitForTimeout(500);
  await openBeats(page);
  check('with the whole library', (await beats(page)).length === 3 && (await beats(page))[0] === 'Second Wind', JSON.stringify(await beats(page)));
  await shot(page, 'beats');

  // versions
  await page.getByLabel('Name for the version').fill('before the breakdown');
  await page.getByRole('button', { name: 'Save a version' }).click();
  await page.waitForSelector('.versions li');
  await page.keyboard.press('Escape');
  await cell(page, 5, 3).click();
  await cell(page, 6, 0).click();
  await page.waitForTimeout(500);
  await openBeats(page);
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.waitForFunction(() => document.querySelector('.modal') === null);
  await page.waitForTimeout(150);
  check('a saved version can be gone back to', (await isOn(page, 5, 3)) && !(await isOn(page, 6, 0)));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('and undo returns to where you were', !(await isOn(page, 5, 3)) && (await isOn(page, 6, 0)));
  await page.keyboard.press('Control+s');
  check('Ctrl+S saves a version', ((await page.locator('.toast').textContent({ timeout: 3000 }).catch(() => '')) ?? '').includes('Version saved'));
  await openBeats(page);
  check('versions are listed newest first', (await page.locator('.versions li').count()) === 2 && (await page.locator('.versions .vl').first().textContent()) === 'Version 2');
  await page.getByRole('button', { name: 'Delete the version before the breakdown' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.versions li').length === 1, undefined, { timeout: 3000 }).catch(() => {});
  check('a version can be deleted', (await page.locator('.versions li').count()) === 1);
  await page.getByRole('button', { name: 'Delete Old Faithful copy' }).click();
  await page.locator('.beats').getByRole('button', { name: 'Keep' }).click();
  check('deleting a beat asks first', (await beats(page)).length === 3);
  await page.getByRole('button', { name: 'Delete Old Faithful copy' }).click();
  await page.locator('.beats').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.beats li').length === 2);
  await page.getByRole('button', { name: 'Delete Second Wind' }).click();
  await page.locator('.beats').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lcd .num')?.textContent === '97', undefined, { timeout: 5000 });
  check('deleting the open beat moves to another one', JSON.stringify(await beats(page)) === '["Old Faithful"]', JSON.stringify(await beats(page)));
  await page.keyboard.press('Escape');

  // ---- history ----
  await page.locator('.lcd .num').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(450);
  await cell(page, 0, 2).click();
  await page.waitForTimeout(450);
  await page.locator('.row[data-row="0"] .ms').first().click();
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const steps = await page.locator('.modal ol li span').allTextContents();
  check('history says what each step did', steps[0] === 'Muted KICK' && steps[1] === 'KICK: pattern A' && steps[2] === 'Tempo 97 → 98', steps.slice(0, 4).join(' | '));
  await page.locator('.modal ol li button').nth(2).click();
  check('picking a step goes back to it', (await page.locator('.lcd .num').textContent()) === '98' && !(await isOn(page, 0, 2))
    && (await page.locator('.modal ol li button.undone').count()) === 2);
  await page.locator('.modal ol li button').first().click();
  check('and forward again', (await isOn(page, 0, 2)) && (await page.locator('.row[data-row="0"] .ms.on').count()) === 1);
  await shot(page, 'history');
  await page.keyboard.press('Escape');
  await page.locator('.row[data-row="0"] .ms').first().click();

  // ---- command palette ----
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.type('thnight');
  check('the palette finds things from a few letters', (await page.locator('.palette .list button.on span').textContent()) === 'Theme: Night');
  await shot(page, 'palette');
  await page.keyboard.press('Enter');
  check('Enter does it and closes the palette', (await page.locator('.palette').count()) === 0 && (await page.evaluate(() => document.documentElement.dataset.theme)) === 'night');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('sound dust snare');
  await page.keyboard.press('Enter');
  check('a sound can be put on the selected track from the palette', (await page.locator('.row[data-row="0"] .name b').textContent()) === 'SNARE'
    && (await page.locator('.kits .seg button.on').textContent()) === 'Dust');
  await page.keyboard.press('Control+z');
  await page.locator('.name').first().focus();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('zzqq');
  check('nothing to find is said plainly', (await page.locator('.palette p').textContent())!.includes('Nothing matches'));
  await page.keyboard.press('Control+k');
  check('the same shortcut closes it', (await page.locator('.palette').count()) === 0);
  await page.getByRole('button', { name: 'Find anything' }).click();
  await page.keyboard.type('export mp3');
  check('it works from its button too, and lists exports', (await page.locator('.palette .list button.on span').textContent()) === 'Export MP3');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+c');
  await page.keyboard.press('Shift+c');
  await page.keyboard.press('Shift+c');

  // ---- shortcuts ----
  await page.keyboard.press('c');
  check('C switches the metronome on', (await page.getByRole('button', { name: 'Metronome', exact: true }).getAttribute('aria-pressed')) === 'true');
  await page.keyboard.press('c');
  await page.keyboard.press('Shift+Slash');
  await page.getByRole('button', { name: /^Shortcut for Metronome on \/ off: C/ }).click();
  await page.keyboard.press('1');
  check('a key that plays pads can\'t be taken', (await page.locator('.modal [role=status]').textContent())!.includes('plays pads'));
  await page.keyboard.press('n');
  check('a shortcut can be changed', (await page.getByRole('button', { name: /^Shortcut for Metronome on \/ off: N/ }).count()) === 1);
  await page.getByRole('button', { name: /^Shortcut for Tap tempo: T/ }).click();
  await page.keyboard.press('r');
  check('taking a key that is in use says who had it', (await page.locator('.modal [role=status]').textContent())!.includes('Record what you play')
    && (await page.getByRole('button', { name: /^Shortcut for Record what you play into the pattern: none/ }).count()) === 1);
  await page.getByRole('button', { name: /^Shortcut for Undo: Ctrl\+Z/ }).click();
  await page.keyboard.press('Escape');
  check('Esc cancels a change without closing the list', (await page.locator('.modal').count()) === 1 && (await page.getByRole('button', { name: /^Shortcut for Undo: Ctrl\+Z/ }).count()) === 1);
  await shot(page, 'shortcuts');
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  const viaN = (await page.getByRole('button', { name: 'Metronome', exact: true }).getAttribute('aria-pressed')) === 'true';
  await page.keyboard.press('c');
  check('the new key works and the old one is free', viaN && (await page.getByRole('button', { name: 'Metronome', exact: true }).getAttribute('aria-pressed')) === 'true');
  await page.reload();
  await page.waitForSelector('.cell');
  await page.keyboard.press('n');
  check('changed shortcuts and settings are remembered', (await page.getByRole('button', { name: 'Metronome', exact: true }).getAttribute('aria-pressed')) === 'false');
  await page.keyboard.press('Shift+Slash');
  await page.getByRole('button', { name: 'Reset shortcuts' }).click();
  check('and can be reset', (await page.getByRole('button', { name: /^Shortcut for Metronome on \/ off: C/ }).count()) === 1 && (await page.getByRole('button', { name: 'Reset shortcuts' }).isDisabled()));
  await page.keyboard.press('Escape');

  // ---- metronome, count-in, tap tempo ----
  await page.getByRole('button', { name: /^Count-in before recording/ }).click(); // 1 bar -> 2 bars
  await page.getByRole('button', { name: /^Count-in before recording/ }).click(); // -> off
  await page.getByRole('button', { name: /^Count-in before recording/ }).click(); // -> 1 bar
  check('count-in cycles off, 1 bar, 2 bars', (await page.getByRole('button', { name: /^Count-in before recording/ }).getAttribute('aria-label'))!.endsWith('1 bar'));
  await page.keyboard.press('r');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.lcd .info div:nth-child(2) b')?.textContent?.startsWith('in '), undefined, { timeout: 4000 });
  const counting = await pos(page);
  const lit = await page.locator('.cell.ph').count();
  await page.waitForSelector('.cell.ph', { timeout: 6000 });
  check('recording starts with a count-in, then the beat', /^in [1-4]$/.test(counting) && lit === 0, counting);
  await page.keyboard.press('Space');
  await page.keyboard.press('r');
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph', { timeout: 3000 });
  check('plain playback starts straight away', !(await pos(page)).startsWith('in'));
  await page.keyboard.press('Space');
  for (let i = 0; i < 5; i++) { await page.locator('.lcd .tap').click(); await page.waitForTimeout(400); }
  const tapped = +(await page.locator('.lcd .num').textContent())!;
  check('tap tempo sets the tempo', Math.abs(tapped - 150) < 20, `${tapped} bpm`);

  // ---- loop region ----
  const ruler = (await page.locator('.ticks').boundingBox())!;
  const x = (step: number) => ruler.x + ((step + 0.5) / 16) * ruler.width;
  await page.mouse.move(x(4), ruler.y + 6);
  await page.mouse.down();
  await page.mouse.move(x(7), ruler.y + 6, { steps: 6 });
  await page.mouse.up();
  check('dragging on the ruler sets a loop region', (await page.locator('.rhead .label').textContent()) === 'Loop 5–8' && (await page.locator('.cell.out').count()) === (await page.locator('.row[data-row]').count()) * 12);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) { seen.add(await pos(page)); await page.waitForTimeout(40); }
  check('and playback stays inside it', [...seen].every((p) => p.startsWith('1.2.')) && seen.size >= 3, [...seen].join(' '));
  await page.keyboard.press('Shift'); // the keyboard is in use again, as it would be for someone tabbing here
  await page.locator('.ticks').focus();
  await page.keyboard.press('ArrowRight');
  check('the region moves with the arrow keys', (await page.locator('.rhead .label').textContent()) === 'Loop 9–12');
  await shot(page, 'loop-region');
  await page.getByRole('button', { name: 'Loop the whole pattern again' }).click();
  await page.waitForTimeout(1200);
  const all = new Set<string>();
  for (let i = 0; i < 40; i++) { all.add((await pos(page)).slice(0, 3)); await page.waitForTimeout(50); }
  check('clearing it plays the whole pattern again', all.size >= 3 && (await page.locator('.cell.out').count()) === 0, [...all].join(' '));
  await page.keyboard.press('Space');

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
