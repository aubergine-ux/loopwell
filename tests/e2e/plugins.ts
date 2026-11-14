// End-to-end check of the plugin host against the production build: a real
// Web Audio Module is loaded, played, opened, saved in a link and exported.
// Run with: npm run test:plugins   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { encodeBeat } from '../../src/core/share';
import { TEMPLATES } from '../../src/core/templates';
import { decodeWav } from '../../src/core/wav';

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
async function exportWav(page: Page): Promise<{ peak: number; seconds: number }> {
  await page.getByTitle(/^Export WAV/).click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }) as Promise<Download>, page.locator('.modal .audio > button').click()]);
  const w = decodeWav(new Uint8Array(readFileSync((await d.path())!)));
  let peak = 0;
  for (const x of w.channels[0]) peak = Math.max(peak, Math.abs(x));
  return { peak, seconds: w.channels[0].length / w.sampleRate };
}
const ready = (page: Page, n = 1) => page.waitForFunction((k) => document.querySelectorAll('.plugs .chain li').length === k
  && [...document.querySelectorAll('.plugs .chain li')].every((li) => !(li.querySelector('.btns .btn:not(.ghost)') as HTMLButtonElement)?.disabled && !li.classList.contains('bad')), n, { timeout: 30000 });

// somebody else's server, where a plugin a stranger's link points at would live
const asked: string[] = [];
const far = createServer((req, res) => { asked.push(req.url ?? ''); res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end('nothing here'); });
await new Promise<void>((ok) => far.listen(0, '127.0.0.1', ok));
const farUrl = `http://127.0.0.1:${(far.address() as AddressInfo).port}/`;

const b = await launch();
const { page, url, errors } = b;
try {
  const loaded: string[] = [];
  page.on('request', (r) => loaded.push(r.url()));
  await page.route('https://www.webaudiomodules.com/community/plugins.json', (r) => r.fulfill({
    contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify([
      { identifier: 'a.synth', name: 'Test Synth', vendor: 'Someone', description: 'A synth from the list', keywords: ['synth'], category: ['Instrument'], path: 'someone/synth/index.js', thumbnail: 'someone/synth/shot.png' },
      { identifier: 'a.fx', name: 'Test Delay', vendor: 'Someone', description: 'A delay from the list', keywords: ['delay'], category: ['Effect'], path: 'someone/delay/index.js' },
      { identifier: 'a.bad', name: 'Sneaky', vendor: 'Nobody', path: '../../../evil.js' },
    ]),
  }));
  await page.route('https://www.webaudiomodules.com/community/plugins/**', (r) => r.abort());

  await page.goto(url);
  await page.waitForSelector('.cell');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check('no plugin code is fetched until a plugin is used', !loaded.some((u) => /plugins\/(sdk|pluck|wobble)\//.test(u)));

  // --- put the example synth on the lead track ---
  await page.locator('.row[data-row="7"] .name').click();
  await tab(page, 'Sound');
  await page.locator('.sound .seg button', { hasText: 'Plugin' }).click();
  await page.waitForSelector('.modal .plugin');
  check('the browser lists what comes with Loopwell, instruments first for an empty track',
    (await page.locator('.modal .plugin b').first().textContent())?.includes('Pluck') === true && (await page.locator('.modal .plugin').count()) === 2);
  await shot(page, 'plugins-browser');
  await page.locator('.modal .plugin', { hasText: 'Pluck' }).click();
  await ready(page);
  check('choosing one makes the track a plugin track and starts it', (await page.locator('.sound .seg button.on').textContent()) === 'Plugin'
    && (await page.locator('.plugs .chain li b').first().textContent()) === 'Pluck' && (await page.locator('.plugs .chain li small').first().textContent()) === 'Loopwell');
  await shot(page, 'plugins-track');

  // --- it plays the track's notes, through the track ---
  await page.getByRole('button', { name: 'Solo LEAD' }).click();
  await page.keyboard.press('Space');
  const playing = await loudest(page, 2500);
  check('the plugin plays the track\'s notes', playing > 0.02, `meter ${playing.toFixed(3)}`);
  // solo a track with nothing on it instead: the plugin's sound obeys the mixer like any other track's
  await page.getByRole('button', { name: 'Solo LEAD' }).click();
  await page.getByRole('button', { name: 'Solo SNARE' }).click();
  // what was already in the echo and the reverb rings on, as it should: wait it out
  await page.waitForTimeout(4000);
  const muted = await loudest(page, 800);
  check('and the mixer silences it like any other track', muted < playing * 0.1, `meter ${muted.toFixed(3)}`);
  await page.getByRole('button', { name: 'Solo SNARE' }).click();
  await page.getByRole('button', { name: 'Solo LEAD' }).click();
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const rest = await loudest(page, 400);
  check('stopping ends its notes', rest < 0.01, `meter ${rest.toFixed(3)}`);

  // --- its own window ---
  await page.locator('.plugs .chain li .btn', { hasText: 'Open' }).first().click();
  await page.waitForSelector('.modal .face input[type="range"]');
  const sliders = await page.locator('.modal .face input[type="range"]').count();
  check('Open shows the plugin\'s own controls', sliders === 5 && (await page.locator('.modal .face').textContent())!.includes('Brightness'), `${sliders} sliders`);
  await page.locator('.modal .try .btn').nth(3).dispatchEvent('pointerdown', { pointerId: 1 });
  const tried = await loudest(page, 500);
  await page.locator('.modal .try .btn').nth(3).dispatchEvent('pointerup', { pointerId: 1 });
  check('a note can be tried from the window', tried > 0.02, `meter ${tried.toFixed(3)}`);
  await page.locator('.modal .face input[aria-label="Decay"]').fill('6.5');
  await page.locator('.modal .face input[aria-label="Brightness"]').fill('0.2');
  await shot(page, 'plugins-window');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(600);

  // --- an effect after it, which has no window of its own ---
  await page.locator('.plugs .add').click();
  await page.waitForSelector('.modal .plugin');
  check('for an effect, effects come first', (await page.locator('.modal .plugin b').first().textContent())?.includes('Wobble') === true);
  // the community's list
  await page.getByRole('button', { name: "Show the community's plugins" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.modal .plugin').length === 4);
  const names = await page.locator('.modal .plugin b').allTextContents();
  check('the community list is fetched when asked for, and entries with odd addresses are left out', names.some((n) => n.includes('Test Delay')) && names.some((n) => n.includes('Test Synth')) && !names.some((n) => n.includes('Sneaky')), names.join(' | '));
  await page.getByLabel('Search plugins').fill('wob');
  check('search narrows it', (await page.locator('.modal .plugin').count()) === 1);
  await shot(page, 'plugins-community');
  await page.locator('.modal .plugin', { hasText: 'Wobble' }).click();
  await ready(page, 2);
  check('the effect joins the chain', (await page.locator('.plugs .chain li b').allTextContents()).join(',') === 'Pluck,Wobble');
  await page.locator('.plugs .chain li').nth(1).locator('.btn', { hasText: 'Open' }).click();
  await page.waitForSelector('.modal .params input[type="range"]');
  check('a plugin with no window of its own gets sliders for its parameters', (await page.locator('.modal .params input[type="range"]').count()) === 3
    && (await page.locator('.modal .params label span').allTextContents()).join(',') === 'Rate,Depth,Mix');
  await page.locator('.modal .params input[aria-label="Mix"]').fill('0.9');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(600);

  // --- exports hear the plugin ---
  const wav = await exportWav(page);
  check('an export has what the plugin played', wav.peak > 0.02, `peak ${wav.peak.toFixed(3)} over ${wav.seconds.toFixed(1)} s`);

  // --- the settings travel in the link ---
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.goto('about:blank');
  await page.goto(link);
  await page.waitForSelector('.cell');
  const start = page.getByRole('button', { name: /Tap to (play|start)|Play it/ });
  if (await start.count()) await start.first().click();
  await page.locator('.row[data-row="7"] .name').click();
  await tab(page, 'Sound');
  await ready(page, 2);
  check('a link brings the plugins back without asking, since they are Loopwell\'s own', (await page.locator('.plugs .ask').count()) === 0);
  await page.locator('.plugs .chain li .btn', { hasText: 'Open' }).first().click();
  await page.waitForSelector('.modal .face input[type="range"]');
  const decay = await page.locator('.modal .face input[aria-label="Decay"]').inputValue();
  const bright = await page.locator('.modal .face input[aria-label="Brightness"]').inputValue();
  check('with the settings they were left at', Math.abs(+decay - 6.5) < 0.05 && Math.abs(+bright - 0.2) < 0.02, `decay ${decay}, brightness ${bright}`);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.plugs .chain li').nth(1).locator('.btn', { hasText: 'Open' }).click();
  await page.waitForSelector('.modal .params input[type="range"]');
  check('the effect\'s too', Math.abs(+(await page.locator('.modal .params input[aria-label="Mix"]').inputValue()) - 0.9) < 0.02);
  await page.getByRole('button', { name: 'Close' }).click();

  // undo takes the effect off again
  await page.locator('.plugs .chain li').nth(1).getByRole('button', { name: 'Remove Wobble' }).click();
  await ready(page, 1);
  check('a plugin can be removed', (await page.locator('.plugs .chain li').count()) === 1);
  await page.keyboard.press('Control+z');
  await ready(page, 2);
  check('and undo brings it back', (await page.locator('.plugs .chain li b').allTextContents()).join(',') === 'Pluck,Wobble');

  // --- a stranger's plugin: nothing runs until the person says so ---
  const p = TEMPLATES[1].make();
  p.tracks[7].kind = 'plugin';
  p.tracks[7].plugins = [{ url: `${farUrl}evil/index.js`, name: 'Totally Fine Synth', state: '' }];
  await page.goto('about:blank');
  await page.goto(`${url}#b=${encodeBeat(p)}`);
  await page.waitForSelector('.cell');
  const start2 = page.getByRole('button', { name: /Tap to (play|start)|Play it/ });
  if (await start2.count()) await start2.first().click();
  await page.locator('.row[data-row="7"] .name').click();
  await tab(page, 'Sound');
  await page.waitForSelector('.plugs .ask');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  check('a link with someone else\'s plugin asks first, naming where it is from', (await page.locator('.plugs .ask b').textContent())!.includes(new URL(farUrl).host));
  check('and fetches nothing from there until then', asked.length === 0, asked.join(','));
  await shot(page, 'plugins-ask');
  const silent = await exportWav(page);
  check('exports leave it out too', asked.length === 0 && silent.peak > 0);
  await page.locator('.plugs .ask .btn').click();
  await page.waitForSelector('.plugs .chain li.bad', { timeout: 40000 });
  check('saying yes fetches it', asked.some((u) => u.includes('/evil/index.js')), asked.join(','));
  check('a plugin that will not load says why, and the app carries on', /could not be loaded/.test((await page.locator('.plugs .chain li.bad .status').textContent()) ?? ''));
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');
  await shot(page, 'plugins-failed');

  // --- an address typed in ---
  await page.locator('.plugs .chain li').first().locator('.btn', { hasText: 'Change' }).click();
  await page.getByLabel('Address of a plugin').fill('ftp://nope/index.js');
  await page.locator('.modal form .btn').click();
  check('an address that is not https is refused', /https:\/\//.test((await page.locator('.modal .error').textContent()) ?? ''));
  await page.getByLabel('Address of a plugin').fill(`${url}plugins/pluck/index.js`);
  await page.locator('.modal form .btn').click();
  await ready(page, 1);
  check('a plugin can be loaded by its address', (await page.locator('.plugs .chain li.bad').count()) === 0);

  // the plugin that isn't there is meant to fail to load; each browser words that its own way
  const real = errors.filter((e) => !/favicon|404|Failed to load resource|ERR_FAILED|ERR_ABORTED|Cross-Origin Request Blocked|Module source URI is not allowed|Loading (failed for the )?module|NetworkError/.test(e));
  check('no errors on the page', real.length === 0, real.join(' | '));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
  await shot(page, 'plugins-crashed');
} finally {
  await b.close();
  far.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
