// End-to-end check of onboarding (the walkthrough, genre templates, tooltips) against the production build.
// Run with: npm run test:onboarding   (set SHOTS=dir to keep screenshots)

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
const title = (page: Page) => page.locator('.card header b').textContent();
const stepIs = (page: Page, t: string) => page.waitForFunction((x) => document.querySelector('.card header b')?.textContent === x, t, { timeout: 5000 }).then(() => true, () => false);
const meter = (page: Page) => page.locator('.lcd .vu i').first().evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));

const b = await launch();
const { page, url } = b;
try {
  // ---- first visit ----
  const began = Date.now();
  await page.goto(url);
  await page.waitForSelector('.cell');
  check('a first visit is offered the walkthrough, without anything in the way', (await page.locator('.invite').count()) === 1 && (await page.locator('.card').count()) === 0
    && (await page.locator('.cell.on').count()) > 0);
  await page.getByRole('button', { name: 'Show me how' }).click();
  await page.waitForSelector('.card');
  await page.waitForSelector('.spot');
  check('it starts on an empty beat', (await page.locator('.cell.on').count()) === 0 && (await title(page)) === 'Start with a kick' && (await page.locator('.spot').count()) === 1);
  await shot(page, 'tour-1');

  // do what it says, the way a beginner would
  for (const s of [0, 4, 8, 12]) await cell(page, 0, s).click();
  check('putting the kicks in moves it on by itself', await stepIs(page, 'Hear it'));
  await page.locator('.tbtn.play').click();
  check('pressing play moves it on', await stepIs(page, 'Add a backbeat'));
  await cell(page, 2, 4).click();
  await cell(page, 2, 12).click();
  check('then the claps', await stepIs(page, 'Paint some hi-hats'));
  const from = (await cell(page, 3, 0).boundingBox())!, to = (await cell(page, 3, 7).boundingBox())!;
  await page.mouse.move(from.x + 6, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(to.x + 6, to.y + 10, { steps: 14 });
  await page.mouse.up();
  check('then painting hats', await stepIs(page, 'Pick the bass'));
  await page.locator('.row[data-row="6"] .name').click();
  check('picking the bass opens its piano roll', (await stepIs(page, 'Draw a bassline')) && (await page.locator('.lane').count()) === 1);
  await shot(page, 'tour-6');
  const lane = (await page.locator('.lane').boundingBox())!;
  const view = (await page.locator('.roll .scroller').boundingBox())!;
  for (const [fx, dy] of [[0.03, 30], [0.28, 66], [0.53, 48]]) await page.mouse.click(lane.x + lane.width * fx, view.y + dy);
  check('three notes are a bassline', await stepIs(page, 'Give it some swing'));
  await page.getByRole('slider', { name: 'Swing' }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
  await page.waitForSelector('.card.done', { timeout: 5000 });
  const took = (Date.now() - began) / 1000;
  check('and the walkthrough finishes on a beat that is playing', (await page.locator('.cell.ph').count()) > 0 && (await meter(page)) > 0.02, `${took.toFixed(0)} s for a script`);
  await shot(page, 'tour-done');
  await page.getByRole('button', { name: 'Try a template' }).click();
  check('it leads on to the templates', (await page.locator('.modal .seg button.on').textContent()) === 'Templates' && (await page.locator('.modal .list button').count()) === 5);
  await shot(page, 'templates');

  // ---- templates ----
  for (const [name, bpm, kit] of [['Trap', '140', 'Punch'], ['House', '124', 'Boom'], ['Boom bap', '88', 'Dust'], ['Lo-fi', '78', 'Dust'], ['Drill', '142', 'Glass']]) {
    if (!(await page.locator('.modal').count())) { await page.getByRole('button', { name: 'Beats', exact: true }).click(); await page.getByRole('radio', { name: 'Templates' }).click(); }
    await page.locator('.modal .list button', { hasText: name }).first().click();
    await page.waitForFunction((x) => document.querySelector('.lcd .num')?.textContent === x, bpm, { timeout: 5000 });
    await page.waitForSelector('.cell.ph', { timeout: 6000 });
    let loud = 0;
    for (let i = 0; i < 16; i++) { loud = Math.max(loud, await meter(page)); await page.waitForTimeout(60); }
    await page.locator('.row[data-row="0"] .name').click();
    await page.getByRole('tab', { name: 'Sound', exact: true }).click();
    const usedKit = await page.locator('.kits .seg button.on').textContent();
    check(`the ${name} template opens at ${bpm} bpm on the ${kit} kit and plays`, loud > 0.05 && usedKit === kit, `level ${loud}, kit ${usedKit}`);
    if (name === 'Trap') {
      check('trap comes with rolling hats and an 808', (await page.locator('.cell[data-roll]').count()) >= 2 && (await page.locator('.row[data-row="6"] .name b').textContent()) === '808');
    }
  }
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'My beats' }).click();
  const mine = await page.locator('.beats li .open b').allTextContents();
  check('each template opened as its own beat, and the first beat is still there', mine.includes('My first beat') && mine.includes('Trap starter') && mine.includes('Drill starter') && mine.length >= 6, mine.join(', '));
  await page.keyboard.press('Escape');

  // ---- tooltips ----
  await page.getByRole('slider', { name: 'Swing' }).hover();
  await page.waitForSelector('.tip', { timeout: 3000 });
  const tip = (await page.locator('.tip').textContent())!;
  check('hovering a knob explains it', tip.startsWith('Pushes every other 16th note late') && tip.includes('Double-click to reset'), tip);
  await shot(page, 'tooltip');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  check('and the explanation goes away with the pointer', (await page.locator('.tip').count()) === 0 && (await page.getByRole('slider', { name: 'Swing' }).getAttribute('title'))!.startsWith('Pushes'));
  await page.getByRole('button', { name: 'Export', exact: true }).hover();
  await page.waitForSelector('.tip');
  check('buttons are explained too', (await page.locator('.tip').textContent())!.includes('Export WAV'));
  await page.mouse.move(5, 5);
  await page.keyboard.press('Tab');
  await page.waitForSelector('.tip', { timeout: 3000 }).catch(() => {});
  check('keyboard focus shows them as well', (await page.locator('.tip').count()) === 1);
  await page.keyboard.press('Shift+Slash');
  await page.getByLabel('Tooltips that explain each control').uncheck();
  await page.keyboard.press('Escape');
  await page.getByRole('slider', { name: 'Swing' }).hover();
  await page.waitForTimeout(900);
  check('tooltips can be switched off, and the browser\'s own stay away too', (await page.locator('.tip').count()) === 0 && (await page.getByRole('slider', { name: 'Swing' }).getAttribute('title')) === null);
  await page.mouse.move(5, 5);
  await page.reload();
  await page.waitForSelector('.cell');
  await page.getByRole('slider', { name: 'Swing' }).hover();
  await page.waitForTimeout(900);
  check('and stay off', (await page.locator('.tip').count()) === 0);
  check('someone who has done the walkthrough is not asked again', (await page.locator('.invite').count()) === 0);
  await page.mouse.move(5, 5);

  // the walkthrough can be run again, and left at any point
  await page.keyboard.press('Control+k');
  await page.keyboard.type('walkthrough');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.card');
  await page.getByRole('button', { name: 'Skip this step' }).click();
  check('a step can be skipped', (await title(page)) === 'Hear it');
  await page.keyboard.press('Escape');
  check('and Escape ends it', (await page.locator('.card').count()) === 0 && (await page.locator('.spot').count()) === 0);

  // ---- someone who declines ----
  const ctx2 = await b.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(url);
  await p2.waitForSelector('.invite');
  await p2.getByRole('button', { name: 'No thanks' }).click();
  await p2.reload();
  await p2.waitForSelector('.cell');
  check('"No thanks" is remembered', (await p2.locator('.invite').count()) === 0 && (await p2.locator('.cell.on').count()) > 0);
  await ctx2.close();

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
