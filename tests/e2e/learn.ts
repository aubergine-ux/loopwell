// End-to-end check of learn mode against the production build: each lesson is
// done the way a person would, and a beat is recreated by ear (well, by test).
// Run with: npm run test:learn   (set SHOTS=dir to keep screenshots)

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
const cell = (page: Page, row: number, step: number) => page.locator(`.cell[data-t="${row}"][data-s="${step}"]`);
const card = (page: Page) => page.locator('.card header b').textContent();
/** Wait for the lesson to move on to the step with this title. */
const step = (page: Page, title: string) => page.waitForFunction((t) => document.querySelector('.card header b')?.textContent === t && !document.querySelector('.card .n.ok'), title, { timeout: 15000 });
const openLearn = async (page: Page) => { await page.keyboard.press('Control+k'); await page.waitForSelector('.palette input'); await page.keyboard.type('learn lessons'); await page.keyboard.press('Enter'); await page.waitForSelector('.modal .list'); };
const pct = (page: Page) => page.locator('.challenge .score b').textContent().then((s) => parseInt(s ?? '0', 10));
async function dragKnob(page: Page, sel: string, dy: number): Promise<void> {
  const b = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

const b = await launch();
const { page, url, errors } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  await openLearn(page);
  check('Learn lists four lessons and four beats to recreate', (await page.locator('.modal .list').first().locator('button').count()) === 4 && (await page.locator('.modal .list').nth(1).locator('button').count()) === 4);
  await shot(page, 'learn-menu');

  // ---- lesson: trap hi-hats ----
  await page.locator('.modal .list button', { hasText: 'A trap hi-hat pattern' }).click();
  await step(page, 'Straight eighths first');
  check('the lesson opens a beat with drums and no hats', (await page.locator('.row[data-row="3"] .cell.on').count()) === 0 && (await page.locator('.row[data-row="0"] .cell.on').count()) > 0);
  for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) await cell(page, 3, s).click();
  await step(page, 'Hear it');
  await page.keyboard.press('Space');
  await step(page, 'Pick a hat to roll');
  await cell(page, 3, 14).click({ button: 'right' });
  await step(page, 'Roll it');
  await shot(page, 'learn-hats');
  await page.locator('.tools section').first().getByRole('button', { name: '×3' }).click();
  await step(page, 'And another, somewhere else');
  await cell(page, 3, 6).click({ button: 'right' });
  await page.locator('.tools section').first().getByRole('button', { name: '×2' }).click();
  await step(page, 'Make them breathe');
  // drag two hats down to soften them
  for (const s of [2, 10]) {
    const box = (await cell(page, 3, s).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForSelector('.card.done', { timeout: 15000 });
  check('doing each step moves the hi-hat lesson on to its end', (await card(page)) === 'That is a trap hi-hat pattern');
  await page.keyboard.press('Space');
  await page.locator('.card.done .btn', { hasText: 'More lessons' }).click();
  await page.waitForSelector('.modal .list');
  check('and it is ticked off in the list', (await page.locator('.modal .list button.done', { hasText: 'A trap hi-hat pattern' }).count()) === 1);

  // ---- lesson: sidechain ----
  await page.locator('.modal .list button', { hasText: 'Sidechain a bass' }).click();
  await step(page, 'Listen first');
  await page.keyboard.press('Space');
  await step(page, 'Select the bass');
  await page.locator('.row[data-row="6"] .name').click();
  await step(page, 'Open its effect rack');
  await page.getByRole('tab', { name: 'Rack', exact: true }).click();
  await step(page, 'Add a Sidechain');
  await page.locator('.rack').getByRole('button', { name: /Sidechain/ }).first().click();
  await step(page, 'Turn it up until it pumps');
  await shot(page, 'learn-sidechain');
  const amount = page.locator('.rack').getByRole('slider', { name: 'Amount' });
  await amount.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  await step(page, 'Set how fast it comes back');
  const release = page.locator('.rack').getByRole('slider', { name: 'Release' });
  await release.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.card.done', { timeout: 15000 });
  check('the sidechain lesson can be done from start to finish', (await card(page)) === 'The bass now makes room for the kick');
  await page.keyboard.press('Space');
  await page.locator('.card.done .btn', { hasText: 'More lessons' }).click();

  // ---- lesson: chop a sample ----
  await page.locator('.modal .list button', { hasText: 'Chop a sample' }).click();
  await step(page, 'Meet the break');
  check('the chop lesson makes its own drum break to work on', (await page.locator('.row[data-row="5"] .name b').textContent()) === 'BREAK');
  await page.locator('.row[data-row="5"] .name').click();
  await step(page, 'Turn it into slices');
  await page.locator('.sound .seg button', { hasText: 'Slice' }).click();
  await step(page, 'Look at the cuts');
  await step(page, 'Play the pieces in a new order');
  await shot(page, 'learn-chop');
  const roll = (await page.locator('.roll .scroller').boundingBox())!;
  // four notes on four different rows of the piano roll
  for (let i = 0; i < 4; i++) await page.mouse.click(roll.x + 120 + i * 90, roll.y + 30 + i * 22);
  await step(page, 'Hear your chop');
  await page.keyboard.press('Space');
  await page.waitForSelector('.card.done', { timeout: 15000 });
  check('the chop lesson can be done from start to finish', (await card(page)) === 'You chopped a break');
  await page.keyboard.press('Space');
  await page.locator('.card.done .btn', { hasText: 'Keep playing with it' }).click();
  check('and leaves you with the beat to carry on with', (await page.locator('.card').count()) === 0 && (await page.locator('.row[data-row="5"] .name b').textContent()) === 'BREAK');

  // a lesson can be skipped through and left
  await openLearn(page);
  check('progress is kept', (await page.locator('.modal .list').first().locator('button.done').count()) === 3);
  await page.locator('.modal .list button', { hasText: 'A trap hi-hat pattern' }).click();
  await step(page, 'Straight eighths first');
  await page.locator('.card .btn', { hasText: 'Skip this step' }).click();
  await step(page, 'Hear it');
  await page.locator('.card .btn', { hasText: 'End the lesson' }).click();
  check('a lesson can be skipped through or left at any step', (await page.locator('.card').count()) === 0);

  // ---- recreate this beat ----
  await openLearn(page);
  await page.locator('.modal .list button', { hasText: 'Four on the floor' }).click();
  await page.waitForSelector('.challenge');
  check('a challenge opens an empty grid and starts at 0%', (await page.locator('.cell.on').count()) === 0 && (await pct(page)) === 0);
  check('and plays the beat to match', (await page.locator('.challenge .btn', { hasText: 'Stop' }).first().count()) === 1 || (await page.locator('.challenge .btn', { hasText: 'Hear it' }).count()) === 1);
  for (const s of [0, 4, 8, 12]) await cell(page, 0, s).click();
  const kicks = await pct(page);
  check('the meter climbs as hits are found', kicks > 30 && kicks < 70, `${kicks}%`);
  check('and says which tracks are right', (await page.locator('.challenge .tracks li.ok').count()) === 1 && /KICK/.test((await page.locator('.challenge .tracks li.ok').textContent()) ?? ''));
  await cell(page, 0, 1).click();
  const wrong = await pct(page);
  check('a wrong hit takes it back down', wrong < kicks && /1 too many/.test((await page.locator('.challenge .tracks li').first().textContent()) ?? ''), `${wrong}%`);
  await cell(page, 0, 1).click();
  await page.locator('.challenge .btn', { hasText: 'Peek' }).click();
  check('Peek shows where the hits are', (await page.locator('.challenge .peek .prow').count()) === 3 && (await page.locator('.challenge .peek .prow').first().locator('i.on').count()) === 4);
  await shot(page, 'learn-challenge');
  for (const s of [4, 12]) await cell(page, 2, s).click();
  for (const s of [2, 6, 10]) await cell(page, 3, s).click();
  const nearly = await pct(page);
  check('nearly there is not there yet', nearly >= 85 && nearly < 100 && (await page.locator('.challenge.won').count()) === (nearly >= 90 ? 1 : 0), `${nearly}%`);
  await cell(page, 3, 14).click();
  await page.waitForSelector('.challenge.won');
  check('matching it says so, and offers the next one', (await pct(page)) === 100 && /Matched, with a peek/.test((await page.locator('.challenge .say').textContent()) ?? '') && (await page.locator('.challenge .btn', { hasText: 'Next beat' }).count()) === 1);
  await shot(page, 'learn-matched');
  await page.locator('.challenge .btn', { hasText: 'Hear mine' }).click();
  await page.waitForSelector('.cell.ph');
  await page.locator('.challenge .btn', { hasText: 'Stop mine' }).click();
  await page.locator('.challenge .btn', { hasText: 'Next beat' }).click();
  await page.waitForFunction(() => document.querySelector('.challenge .what b')?.textContent === 'Boom bap');
  check('the next beat starts from an empty grid again', (await page.locator('.cell.on').count()) === 0 && (await pct(page)) === 0);
  await page.locator('.challenge .btn', { hasText: 'Leave' }).click();
  await page.waitForSelector('.modal .list');
  check('the best score is kept', /Best 100%/.test((await page.locator('.modal .list button', { hasText: 'Four on the floor' }).textContent()) ?? '') && (await page.locator('.challenge').count()) === 0);

  // survives a reload
  await page.reload();
  await page.waitForSelector('.cell');
  await openLearn(page);
  check('progress survives a reload', (await page.locator('.modal .list').first().locator('button.done').count()) === 3 && (await page.locator('.modal .list').nth(1).locator('button.done').count()) === 1);

  // opening another beat leaves a challenge
  await page.locator('.modal .list button', { hasText: 'Trap bounce' }).click();
  await page.waitForSelector('.challenge');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.on');
  check('opening another beat leaves the challenge', (await page.locator('.challenge').count()) === 0);

  // phone
  await page.setViewportSize({ width: 390, height: 800 });
  await openLearn(page);
  await page.locator('.modal .list button', { hasText: 'Boom bap' }).click();
  await page.waitForSelector('.challenge');
  await page.waitForTimeout(300);
  check('the challenge fits a phone', await page.evaluate(() => document.querySelector('.challenge')!.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1));
  await shot(page, 'learn-phone');

  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, `${e instanceof Error ? e.message.split('\n')[0] : String(e)} (at: ${await card(page).catch(() => 'no card')})`);
  await shot(page, 'learn-crashed');
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
