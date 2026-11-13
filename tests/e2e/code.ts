// End-to-end check of the live-coding panel against the production build.
// Run with: npm run test:code   (set SHOTS=dir to keep screenshots)

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
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
const meter = (page: Page) => page.locator('.lcd .vu i').first().evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));
async function loudest(page: Page, ms: number): Promise<number> {
  let top = 0;
  for (const end = Date.now() + ms; Date.now() < end;) { top = Math.max(top, await meter(page)); await page.waitForTimeout(40); }
  return top;
}
const palette = async (page: Page, what: string) => { await page.keyboard.press('Control+k'); await page.keyboard.type(what); await page.keyboard.press('Enter'); };
const status = (page: Page) => page.locator('#code-status').textContent().then((s) => (s ?? '').trim());
const lit = (page: Page, row: number) => page.locator(`.row[data-row="${row}"] .cell.on`).count();

const b = await launch();
const { page, url, errors } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  await palette(page, 'clear the whole pattern');
  await page.waitForFunction(() => !document.querySelector('.cell.on'));
  await tab(page, 'Code');
  const area = page.getByLabel('Live code');
  check('an empty panel says what to type and which tracks there are', /kick: x ~ x ~/.test(await status(page)) && /kick, snare/.test(await status(page)));

  await area.fill('kick: x*4');
  check('a line is understood as it is typed', /^1 line playing when you press play/.test(await status(page)), await status(page));
  check('and drawn as a bar with its hits', (await page.locator('.lane .strip i').count()) === 4 && (await page.locator('.lane .who').textContent()) === 'KICK');

  // the grid is empty: anything heard is the code
  await page.locator('.back, body').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await area.blur();
  await page.keyboard.press('Space');
  const heard = await loudest(page, 1500);
  check('the code plays when the transport does', heard > 0.05, `meter ${heard.toFixed(3)}`);
  check('with a playhead on its bar', (await page.locator('.lane .strip b').count()) === 1);

  // edited while it plays
  await area.fill('kick: x*4\nhat: [x x x]*4\nsnare: ~ x');
  await page.waitForTimeout(300);
  check('lines added while playing join in', (await page.locator('.lane').count()) === 3 && /^3 lines playing\.$/.test(await status(page)), await status(page));
  await shot(page, 'code-playing');

  // typing in the editor is typing, not shortcuts
  await area.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(' m s');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check('letters and the space bar go into the text, not to the app\'s shortcuts', (await area.inputValue()).endsWith('snare: ~ x m s ') && (await loudest(page, 600)) > 0.05
    && (await page.locator('.row.off').count()) === 0);

  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  check('the command palette still opens from inside the editor', true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.palette'));

  // a mistake
  await area.fill('kick: x*4 [\nhat: [x x x]*4');
  await page.waitForTimeout(200);
  const said = await status(page);
  check('a mistake is pointed out, and the line keeps playing what it had', /Line 1: "\]" is missing\. Still playing what it had before\./.test(said) && (await page.locator('.lane').count()) === 2, said);
  check('so the music doesn\'t stop', (await loudest(page, 800)) > 0.05);
  await page.locator('#code-status .err').click();
  check('clicking the message puts the cursor on the mistake', (await area.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)) === 11);
  await shot(page, 'code-error');
  await area.fill('nope: x');
  check('a track that doesn\'t exist is named, with the ones that do', /no track called "nope".*kick, snare/.test(await status(page)));

  // off and on
  await area.fill('kick: x*4');
  await page.getByRole('button', { name: 'On', exact: true }).click();
  // the last hit rings out first
  await page.waitForTimeout(2500);
  const off = await loudest(page, 600);
  check('switched off, it is silent', off < 0.01 && /Switched off/.test(await status(page)), `meter ${off.toFixed(3)}`);
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  check('and back on, it plays', (await loudest(page, 900)) > 0.05);
  await area.blur();
  await page.keyboard.press('Space');

  // to the grid
  await area.fill('kick: x x x x\nlead: c4 _ eb4 ~');
  await page.getByRole('button', { name: 'To grid' }).click();
  await page.waitForFunction(() => /Written to the grid/.test(document.querySelector('.toast')?.textContent ?? ''));
  check('To grid writes the hits onto the steps', (await lit(page, 0)) === 4 && (await lit(page, 7)) >= 2, `${await lit(page, 0)} kick steps, ${await lit(page, 7)} lead`);
  check('and switches the code off so nothing doubles', (await page.getByRole('button', { name: 'Off', exact: true }).count()) === 1);
  await area.fill('kick: x x x');
  await page.getByRole('button', { name: 'To grid' }).click();
  await page.waitForFunction(() => /between steps/.test(document.querySelector('.toast')?.textContent ?? ''));
  check('hits between steps go to the nearest one, and it says so', /2 hits were between steps/.test((await page.locator('.toast').textContent()) ?? '') && (await lit(page, 0)) === 3);

  // from the grid
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');
  await tab(page, 'Code');
  await page.getByRole('button', { name: 'From grid' }).click();
  const text = await area.inputValue();
  check('From grid writes the pattern out, a line a track', /^kick: +X ~ ~ ~  X ~ ~ ~  X ~ ~ ~  X ~ ~ ~$/m.test(text) && /^lead: +\[c4,d#4,g4\] _ _ ~/m.test(text) && text.split('\n').length === 7, text.split('\n').slice(0, 2).join(' / '));
  check('with no mistakes in it', (await page.locator('#code-status .err').count()) === 0 && /Switched off/.test(await status(page)));
  await shot(page, 'code-from-grid');

  // help, example, clear, undo
  await page.getByRole('button', { name: 'How to write it' }).click();
  check('the notation is explained on the spot', (await page.locator('.help dt').count()) >= 12);
  await page.getByRole('button', { name: 'How to write it' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  check('Clear empties it', (await area.inputValue()) === '');
  await page.keyboard.press('Control+z');
  check('and undo brings it back', (await area.inputValue()) === text);
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Example' }).click();
  check('Example gives something to start from, switched on', /lead: +<c4 eb4 g4 bb4>/.test(await area.inputValue()) && (await page.locator('#code-status .err').count()) === 0
    && (await page.getByRole('button', { name: 'On', exact: true }).count()) === 1);

  // it travels in the link
  const code = await area.inputValue();
  await area.blur();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.cell');
  const start = page.getByRole('button', { name: /Tap to (play|start)|Play it/ });
  if (await start.count()) await start.first().click();
  await tab(page, 'Code');
  check('a share link carries the code', (await page.getByLabel('Live code').inputValue()) === code);

  // small screen
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const fits = await page.evaluate(() => { const el = document.querySelector('.code')!.getBoundingClientRect(); return el.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; });
  check('it fits a phone', fits);
  await shot(page, 'code-phone');

  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
  await shot(page, 'code-crashed');
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
