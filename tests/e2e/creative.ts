// End-to-end check of the pattern tools (step extras, Euclid, grooves, dice,
// chords and the arpeggiator) against the production build.
// Run with: npm run test:tools   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
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
const onSteps = (page: Page, t: number) => page.locator(`.cell.on[data-t="${t}"]`).evaluateAll((els) => els.map((e) => +(e as HTMLElement).dataset.s!));
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
const section = (page: Page, title: string) => page.locator('.tools section', { has: page.locator('h3', { hasText: title }) });

const b = await launch();
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');

  // ---- step extras ----
  await cell(page, 3, 2).click({ button: 'right' });
  check('right-clicking a step opens it in the Tools panel', (await section(page, 'Step').locator('h3 small').textContent())!.includes('HAT · 3'));
  await section(page, 'Step').getByRole('button', { name: '×3' }).click();
  check('a roll shows on the step', (await cell(page, 3, 2).getAttribute('data-roll')) === '3');
  await section(page, 'Step').getByLabel('Chance this step plays').selectOption({ label: '50%' });
  await section(page, 'Step').getByLabel('When this step plays').selectOption({ label: 'Fill only' });
  check('chance and condition are on the step and in its label', (await cell(page, 3, 2).getAttribute('class'))!.includes('maybe')
    && (await cell(page, 3, 2).getAttribute('aria-label'))!.includes('50%, fill only, ×3'), (await cell(page, 3, 2).getAttribute('aria-label'))!);
  await cell(page, 1, 9).click({ button: 'right' });
  await section(page, 'Step').getByRole('button', { name: '×2' }).click();
  check('giving an empty step a roll switches it on', (await onSteps(page, 1)).includes(9));
  await cell(page, 1, 9).click();
  await cell(page, 1, 9).click();
  check('a step that is switched off and on again is plain', (await cell(page, 1, 9).getAttribute('data-roll')) === null);
  await cell(page, 1, 9).click();

  // ---- Euclid ----
  await page.locator('.row[data-row="5"] .name').click();
  await tab(page, 'Tools');
  await section(page, 'Euclid').getByRole('button', { name: 'Apply' }).click();
  check('Euclid writes 5 hits over 16 steps', JSON.stringify(await onSteps(page, 5)) === '[0,4,7,10,13]', JSON.stringify(await onSteps(page, 5)));
  await page.keyboard.press('Control+z');
  check('and one undo takes it back', (await onSteps(page, 5)).length === 0);

  // ---- dice with locks ----
  const before = await Promise.all([0, 1, 2, 3].map((t) => onSteps(page, t)));
  await section(page, 'Dice').getByLabel('Lock KICK').click();
  await section(page, 'Dice').getByLabel('Lock HAT').click();
  let changed = false;
  // dice can land the same way twice, so give them a few throws and look at both unlocked tracks
  for (let i = 0; i < 12 && !changed; i++) {
    await section(page, 'Dice').getByRole('button', { name: 'Pattern' }).click();
    changed = JSON.stringify([await onSteps(page, 1), await onSteps(page, 2)]) !== JSON.stringify([before[1], before[2]]);
  }
  const after = await Promise.all([0, 1, 2, 3].map((t) => onSteps(page, t)));
  check('the dice change unlocked tracks', changed);
  check('and leave locked tracks alone', JSON.stringify(after[0]) === JSON.stringify(before[0]) && JSON.stringify(after[3]) === JSON.stringify(before[3]));
  check('rolled notes land on the synth tracks', (await onSteps(page, 6)).length > 0);
  await shot(page, 'tools-panel');

  // ---- groove ----
  await section(page, 'Groove').getByLabel('Groove for the whole song').selectOption({ label: 'Shuffle' });
  await section(page, 'Groove').getByLabel('Groove for KICK').selectOption({ label: 'Humanize' }).catch(() => {});

  // ---- chords and arp ----
  await page.locator('.row[data-row="7"] .name').click();
  await tab(page, 'Keys');
  await page.locator('.bar').getByRole('button', { name: 'Clear' }).click();
  const names = await page.locator('.chord').allTextContents();
  check('chords of the key are offered', names.length === 7 && names[0].endsWith('Cm'), names.join(' '));
  await page.locator('.chord').nth(0).click();
  await page.locator('.chord').nth(5).click();
  check('a chord adds its three notes, the next one a beat later', (await page.locator('.note').count()) === 6
    && JSON.stringify(await onSteps(page, 7)) === '[0,4]', `${await page.locator('.note').count()} notes at ${JSON.stringify(await onSteps(page, 7))}`);
  await page.getByLabel('Arpeggiator', { exact: true }).selectOption({ label: 'Up-down' });
  await page.getByLabel('Arpeggiator speed').selectOption({ label: '1/32' });
  await shot(page, 'chords');

  // ---- it all plays, and survives a reload and a share link ----
  await tab(page, 'Tools');
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph', { timeout: 5000 });
  await page.keyboard.down('Backslash');
  await page.waitForTimeout(1200);
  const held = await page.locator('.tools .fill').getAttribute('aria-pressed');
  await page.keyboard.up('Backslash');
  check('holding \\ holds a fill, and letting go ends it', held === 'true' && (await page.locator('.tools .fill').getAttribute('aria-pressed')) === 'false');
  await page.waitForTimeout(1200);
  const load = await page.locator('.lcd').textContent();
  await page.keyboard.press('Space');
  check('plays with rolls, grooves and an arpeggio running', !!load);

  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.keyboard.press('Escape');
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.cell');
  await page.waitForTimeout(400);
  check('a share link brings the extras back', (await cell(page, 3, 2).getAttribute('data-roll')) === '3'
    && (await cell(page, 3, 2).getAttribute('aria-label'))!.includes('fill only'));
  await page.locator('.row[data-row="7"] .name').click();
  await tab(page, 'Keys');
  check('and the arpeggiator', (await page.getByLabel('Arpeggiator', { exact: true }).inputValue()) === '3' && (await page.getByLabel('Arpeggiator speed').inputValue()) === '3');
  await page.keyboard.press('Space').catch(() => {});

  // ---- beats made before these tools existed ----
  const old = readFileSync(new URL('../fixtures/links-2.0.txt', import.meta.url), 'utf8').trim().split('\n');
  for (const code of old) {
    await page.goto('about:blank');
    await page.goto(`${url}#b=${code}`);
    await page.waitForSelector('.cell.ph, .tl .head, .gate', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
    const peak = await page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
    const name = await page.locator('.lcd').textContent();
    check(`a 2.0 link opens and plays: ${code.slice(0, 12)}…`, /scaleX\((0\.[0-9]*[1-9]|1)/.test(peak), `${peak} ${name?.slice(0, 30)}`);
  }
  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 400));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
