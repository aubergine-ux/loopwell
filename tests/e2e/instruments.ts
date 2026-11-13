// End-to-end check of the 808, the drum synth and the sample browser against the production build.
// Run with: npm run test:sounds   (set SHOTS=dir to keep screenshots)

import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
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
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
const meter = (page: Page, t: number) => page.locator(`.row[data-row="${t}"] .meter i`).evaluate((el) => +(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0));
const rowName = (page: Page, t: number) => page.locator(`.row[data-row="${t}"] .name b`).textContent();

/** A two-bar drum loop at `bpm`, and a short melody in A minor, as WAV files. */
function loopWav(bpm: number): Buffer {
  const sr = 44100, beat = (60 / bpm) * sr;
  const x = new Float32Array(Math.round(beat * 8));
  for (let b = 0; b < 16; b++) {
    const at = Math.round((b * beat) / 2);
    for (let i = 0; i < 3000 && at + i < x.length; i++) x[at + i] += b % 2 ? (((i * 7919) % 13) / 6.5 - 1) * Math.exp(-i / 200) * 0.4 : Math.sin(i * 0.02) * Math.exp(-i / 900);
  }
  return Buffer.from(encodeWav([x], sr, 16));
}
function melodyWav(): Buffer {
  const sr = 44100, notes = [57, 60, 64, 69, 62, 65, 64, 68, 71, 57, 60, 64, 57];
  const each = Math.floor((sr * 5) / notes.length);
  const x = new Float32Array(each * notes.length);
  notes.forEach((n, k) => {
    const f = 440 * Math.pow(2, (n - 69) / 12);
    for (let i = 0; i < each; i++) x[k * each + i] = (Math.sin((2 * Math.PI * f * i) / sr) + 0.4 * Math.sin((4 * Math.PI * f * i) / sr)) * 0.4 * Math.exp((-i / sr) * 2);
  });
  return Buffer.from(encodeWav([x], sr, 16));
}

const b = await launch();
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');

  // ---- 808 ----
  await page.locator('.row[data-row="6"] .name').click();
  await page.locator('.sound .seg').getByRole('button', { name: '808' }).click();
  check('a synth track becomes an 808', (await page.locator('.inst .btn', { hasText: 'Follows key' }).count()) === 1);
  await shot(page, '808');
  await page.locator('.cell[data-t="6"][data-s="0"]').click();
  await page.waitForTimeout(250);
  check('its steps make sound', (await meter(page, 6)) > 0.05, String(await meter(page, 6)));
  await tab(page, 'Keys');
  check('it has a piano roll but no chord strip (one voice)', (await page.locator('.lane').count()) === 1 && (await page.locator('.chord').count()) === 0);
  check('the note sits on the root of the key', (await page.locator('.note').count()) === 1);
  await page.getByLabel('Key', { exact: true }).selectOption({ label: 'F' });
  await tab(page, 'Sound');
  check('changing the song key moves the line', (await page.locator('.inst .note').textContent())!.includes('+5'), (await page.locator('.inst .note').textContent()) ?? '');
  await page.locator('.add').getByRole('button', { name: '808' }).click().catch(() => {});

  // ---- drum synth ----
  await page.locator('.row[data-row="0"] .name').click();
  const kicks = await page.locator('.cell.on[data-t="0"]').count();
  await page.locator('.sound .seg').getByRole('button', { name: 'Knobs' }).click();
  check('a drum track becomes a drum synth and keeps its steps', (await page.locator('.cell.on[data-t="0"]').count()) === kicks && kicks > 0);
  for (const model of ['Snare', 'Hat', 'Clap', 'Kick']) {
    await page.locator('.inst .seg').getByRole('button', { name: model }).click();
    await page.waitForTimeout(180);
    check(`the ${model.toLowerCase()} model sounds`, (await meter(page, 0)) > 0.02, String(await meter(page, 0)));
  }
  await shot(page, 'drum-synth');
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph', { timeout: 5000 });
  let kick = 0, bass = 0;
  for (let i = 0; i < 40; i++) { kick = Math.max(kick, await meter(page, 0)); bass = Math.max(bass, await meter(page, 6)); await page.waitForTimeout(50); }
  check('both play in the pattern', kick > 0.02 && bass > 0.02, `${kick} ${bass}`);
  await page.keyboard.press('Space');

  // ---- they travel ----
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.keyboard.press('Escape');
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.cell');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space').catch(() => {});
  await page.locator('.row[data-row="6"] .name').click();
  check('a share link brings the 808 back', (await page.locator('.inst .btn', { hasText: 'Follows key' }).count()) === 1);
  await page.locator('.row[data-row="0"] .name').click();
  check('and the drum synth', (await page.locator('.inst .seg button.on').textContent()) === 'Kick');
  await page.reload();
  await page.waitForSelector('.cell');
  await page.locator('.row[data-row="0"] .name').click();
  check('and so does a reload', (await page.locator('.inst .seg button.on').count()) === 1);

  // ---- sample browser ----
  await page.locator('.row[data-row="1"] .name').click();
  await page.locator('.sampler').getByRole('button', { name: 'Browse' }).click();
  await page.waitForSelector('.browser');
  check('the browser lists every built-in sound', (await page.locator('.foot span').first().textContent()) === '40 of 40 sounds');
  check('and opens on the sound the track is using', (await page.locator('.row.on .pick b').textContent()) === 'snare');
  await page.getByLabel('Search sounds').fill('dust hat');
  check('search matches name and kit together', (await page.locator('.browser .row').count()) === 2, `${await page.locator('.browser .row').count()} rows`);
  await page.getByLabel('Search sounds').fill('zzzz');
  check('a search with no match says so', (await page.locator('.browser .empty').first().textContent())!.includes('No sound matches'));
  await page.getByLabel('Search sounds').fill('');
  await page.locator('.filters').getByRole('button', { name: 'bass' }).click();
  check('a category narrows the list', (await page.locator('.browser .row').count()) === 4);
  await page.locator('.browser .row .pick').first().click();
  await page.waitForFunction(() => document.querySelector('.side dd')?.textContent !== '…', undefined, { timeout: 5000 });
  const dds = await page.locator('.side dd').allTextContents();
  const heard = await page.waitForFunction(() => /scaleX\((0\.[0-9]*[1-9]|1)/.test((document.querySelector('.lcd .vu i') as HTMLElement).style.transform), undefined, { timeout: 3000 }).then(() => true, () => false);
  check('picking a one-shot shows its length, claims no tempo, and plays it', / (ms|s)$/.test(dds[0]) && dds[1] === '—' && heard, `${dds.join(' | ')} heard: ${heard}`);
  await page.locator('.browser .row .star').first().click();
  await page.locator('.filters').getByRole('button', { name: '★ Favourites' }).click();
  check('a starred sound is in favourites', (await page.locator('.browser .row').count()) === 1);
  await page.getByLabel(/^Add a tag to/).fill('Deep One');
  await page.locator('.addtag').getByRole('button', { name: 'Add' }).click();
  await page.locator('.filters').getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search sounds').fill('deep');
  check('a tag you add can be searched for', (await page.locator('.browser .row').count()) === 1);
  await page.getByLabel('Search sounds').fill('');

  // import: a loop and a melody
  await page.locator('.browser input[type=file]').setInputFiles([
    { name: 'break 100.wav', mimeType: 'audio/wav', buffer: loopWav(100) },
    { name: 'keys.wav', mimeType: 'audio/wav', buffer: melodyWav() },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.browser .row').length === 2, undefined, { timeout: 8000 });
  check('imported sounds appear under Imported, and a file that is not audio is refused', (await page.locator('.toast.error').textContent().catch(() => ''))!.includes('notes.txt')
    && (await page.locator('.browser .row').count()) === 2);
  await page.locator('.browser .row .pick', { hasText: 'break 100' }).click();
  await page.waitForFunction(() => /bpm/.test(document.querySelector('.side dl')?.textContent ?? ''), undefined, { timeout: 8000 }).catch(() => {});
  const loopInfo = await page.locator('.side dd').allTextContents();
  check('the tempo of a loop is detected', loopInfo[1] === '100 bpm', loopInfo.join(' | '));
  await page.locator('.browser .row .pick', { hasText: 'keys' }).click();
  await page.waitForFunction(() => /minor|major/.test(document.querySelector('.side dl')?.textContent ?? ''), undefined, { timeout: 8000 }).catch(() => {});
  const keyInfo = await page.locator('.side dd').allTextContents();
  check('the key of a melody is detected', keyInfo[2] === 'A minor', keyInfo.join(' | '));
  await page.locator('.filters').getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search sounds').fill('100 bpm');
  check('tempo can be searched for', (await page.locator('.browser .row').count()) === 1);
  await page.getByLabel('Search sounds').fill('a minor');
  check('and key', (await page.locator('.browser .row').count()) === 1);
  await shot(page, 'sample-browser');

  // keyboard only
  await page.getByLabel('Search sounds').fill('boom');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const picked = await page.locator('.browser .row.on .pick b').textContent();
  check('arrow keys walk the list', !!picked, picked ?? '');
  await page.locator('.browser .list').focus();
  await page.keyboard.press('Enter');
  check('Enter uses the sound on the track and closes the browser', (await page.locator('.browser').count()) === 0 && (await rowName(page, 1)) === picked!.toUpperCase(), `${await rowName(page, 1)}`);

  // drag a sound out of the browser onto a track behind it
  await page.locator('.sampler').getByRole('button', { name: 'Browse' }).click();
  await page.getByLabel('Search sounds').fill('glass crash');
  // measure where the row is only once the list has narrowed and the dialog has finished arriving
  await page.waitForFunction(() => /crash/i.test(document.querySelector('.browser .row')?.textContent ?? '')
    && document.querySelector('.modal')!.getAnimations().every((x) => x.playState === 'finished'), undefined, { timeout: 10000 });
  await page.waitForTimeout(150);
  const dragged = (await page.locator('.browser .row').first().boundingBox())!, onto = (await page.locator('.row[data-row="5"] .cells').boundingBox())!;
  await page.mouse.move(dragged.x + 80, dragged.y + 10);
  await page.mouse.down();
  await page.mouse.move(dragged.x + 90, dragged.y + 20, { steps: 3 });
  // wait for the drag to have really begun (the dialog steps aside) rather than for a fixed time: a busy machine takes longer
  await page.waitForFunction(() => 'dragging' in document.documentElement.dataset, undefined, { timeout: 5000 }).catch(() => {});
  await page.mouse.move(onto.x + 100, onto.y + 10, { steps: 10 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.browser'), undefined, { timeout: 5000 }).catch(() => {});
  check('a sound can be dragged from the browser onto any track', (await rowName(page, 5)) === 'CRASH' && (await page.locator('.browser').count()) === 0, `${await rowName(page, 5)}`);
  await page.locator('.row[data-row="1"] .name').click();

  // use an imported sound, reload, remove
  await page.locator('.sampler').getByRole('button', { name: 'Browse' }).click();
  await page.locator('.filters').getByRole('button', { name: 'Imported' }).click();
  await page.locator('.browser .row .pick', { hasText: 'break 100' }).dblclick();
  check('double-click uses an imported sound', (await rowName(page, 1)) === 'BREAK 100');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('.cell');
  await page.locator('.row[data-row="1"] .name').click();
  await page.locator('.sampler').getByRole('button', { name: 'Browse' }).click();
  await page.locator('.filters').getByRole('button', { name: '★ Favourites' }).click();
  check('favourites survive a reload', (await page.locator('.browser .row').count()) === 1);
  await page.locator('.filters').getByRole('button', { name: 'Imported' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.browser .row').length === 2, undefined, { timeout: 8000 }).catch(() => {});
  check('and so do imported sounds', (await page.locator('.browser .row').count()) === 2);
  await page.locator('.browser .row .pick', { hasText: 'keys' }).click();
  await page.getByLabel(/^Remove keys/).click();
  check('an imported sound can be removed', (await page.locator('.browser .row').count()) === 1);
  await page.keyboard.press('Escape');
  check('Escape closes the browser', (await page.locator('.browser').count()) === 0);

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 500));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
