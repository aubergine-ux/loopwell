// End-to-end test of the optional community features: the built app in
// headless Chromium talking to the real server (in-process Postgres and file
// storage, development sign-in). Run with: npm run test:community

import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { rig } from '../../server/test/helpers';
import { encodeWav } from '../../src/core/wav';

let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

const b = await launch();
const origin = new URL(b.url).origin;
const server = await rig({ APP_ORIGINS: origin });
await server.app.listen({ port: 0, host: '127.0.0.1' });
const api = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
const ctx = b.page.context();

const modal = (p: Page) => p.locator('.modal');
const tab = (p: Page, name: string | RegExp) => modal(p).getByRole('tab', { name }).click();
const toast = async (p: Page, re: RegExp) => { await p.waitForFunction((s) => new RegExp(s).test(document.querySelector('.toast')?.textContent ?? ''), re.source, { timeout: 6000 }).catch(() => {}); return re.test((await p.locator('.toast').textContent().catch(() => '')) ?? ''); };
// a row of a list in the dialog, found by its exact title
const beatRow = (p: Page, title: string) => modal(p).locator('.beat', { has: p.locator('.meta b', { hasText: new RegExp(`^(\\w+: )?${title.replace('.', '\\.')}$`) }) });

/** A fresh visitor who connects to the server and signs in. */
async function visitor(name: string): Promise<Page> {
  const p = await (await b.browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  p.on('pageerror', (e) => b.errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) b.errors.push(`${name}: ${m.text()}`); });
  await p.goto(`${b.url}#server=${api}`);
  await p.waitForSelector('.cell');
  await p.getByRole('button', { name: 'Community' }).click();
  await p.waitForSelector('.modal');
  await tab(p, 'Sign in');
  await p.getByLabel('Test account name').fill(name);
  await p.getByRole('button', { name: 'Development sign-in' }).click();
  await modal(p).getByRole('tab', { name }).waitFor();
  return p;
}

try {
// ---- local mode is untouched ----
const { page } = b;
await page.goto(b.url);
await page.waitForSelector('.cell');
await page.getByRole('button', { name: 'Community' }).click();
await page.waitForSelector('.modal');
check('with no server, the app only offers to connect to one', (await page.getByLabel('Server address').count()) === 1 && (await modal(page).getByRole('tab').count()) === 0);
await page.getByLabel('Server address').fill('ftp://nope');
await page.getByRole('button', { name: 'Connect' }).click();
check('a bad server address is refused', await toast(page, /not valid/));
await page.keyboard.press('Escape');
await page.keyboard.press('Space');
await page.waitForSelector('.cell.ph');
check('and everything else works without an account', (await page.locator('.cell.ph').count()) > 0);
await page.keyboard.press('Space');

// ---- sign in, publish ----
const ada = await visitor('ada');
check('a link with #server= connects, and signing in works', (await ada.evaluate(() => location.hash)) === '' && (await modal(ada).getByText('@ada').count()) === 1);
await tab(ada, 'Gallery');
await modal(ada).getByText('Nothing here yet').waitFor({ timeout: 5000 }).catch(() => {});
check('the gallery starts empty', await modal(ada).getByText('Nothing here yet').isVisible(), ((await modal(ada).textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300));
await modal(ada).getByRole('button', { name: 'Publish' }).click();
await ada.getByLabel('Title').fill('First light');
await ada.getByLabel('Genre').fill('House');
await ada.getByLabel('Tags').fill('demo, Four Floor');
await modal(ada).getByRole('button', { name: 'Publish', exact: true }).click();
await beatRow(ada, 'First light').waitFor();
const row = (await beatRow(ada, 'First light').textContent())!;
check('publishing puts the beat in the gallery with its tempo, key, genre and tags', /by ada/.test(row) && /120 bpm/.test(row) && /C minor/.test(row) && /house/.test(row) && /#demo/.test(row) && /#four-floor/.test(row), row.replace(/\s+/g, ' '));

// ---- cloud saves and version history ----
await tab(ada, 'My saves');
await modal(ada).getByRole('button', { name: /^Save “untitled” to the cloud/ }).click();
await beatRow(ada, 'untitled').waitFor();
check('a beat can be saved to the cloud', /version 1/.test((await beatRow(ada, 'untitled').textContent())!));
await ada.keyboard.press('Escape');
await ada.locator('.cell[data-t="1"][data-s="6"]').click(); // change something
await ada.getByRole('button', { name: 'Community' }).click();
await ada.waitForSelector('.modal');
await tab(ada, 'My saves');
await modal(ada).getByRole('button', { name: /^Save a new version/ }).click();
await ada.waitForFunction(() => /version 2/.test(document.querySelector('.modal .beat')?.textContent ?? ''));
await modal(ada).getByRole('button', { name: /^History/ }).click();
await modal(ada).locator('.ver').first().waitFor();
check('saving again keeps the earlier version', (await modal(ada).locator('.ver').count()) === 2 && /Version 2 \(current\)/.test((await modal(ada).locator('.versions').textContent())!));
await modal(ada).locator('.ver', { hasText: 'Version 1' }).getByRole('button', { name: 'Open' }).click();
await ada.waitForSelector('.modal', { state: 'detached' });
check('an earlier version can be opened', !((await ada.locator('.cell[data-t="1"][data-s="6"]').getAttribute('class'))!.includes('on')));
await ada.getByRole('button', { name: 'Community' }).click();
await ada.waitForSelector('.modal');
await tab(ada, 'My saves');
await modal(ada).getByRole('button', { name: /^History/ }).click();
await modal(ada).locator('.ver').first().waitFor();
await modal(ada).locator('.ver', { hasText: 'Version 1' }).getByRole('button', { name: 'Restore' }).click();
await ada.waitForFunction(() => /version 3/.test(document.querySelector('.modal .beat')?.textContent ?? ''));
check('or restored as the newest', /version 3/.test((await beatRow(ada, 'untitled').textContent())!));

// ---- sample packs ----
await tab(ada, 'Sample packs');
await modal(ada).getByRole('button', { name: 'New pack' }).click();
await ada.getByLabel('Pack name').fill('Clicks');
await ada.getByLabel('Attribution').fill('Ada L.');
await modal(ada).getByRole('button', { name: 'Create' }).click();
await modal(ada).getByRole('button', { name: 'Add samples' }).waitFor();
const blip = Buffer.from(encodeWav([Float32Array.from({ length: 6000 }, (_, i) => Math.sin(i / 5) * Math.exp(-i / 900))], 44100, 16));
const long = Buffer.from(encodeWav([new Float32Array(8000 * 70)], 8000, 16)); // 70 seconds: over the limit
await modal(ada).locator('input[type=file]').setInputFiles([
  { name: 'blip.wav', mimeType: 'audio/wav', buffer: blip },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio at all') },
  { name: 'long.wav', mimeType: 'audio/wav', buffer: long },
]);
await beatRow(ada, 'blip.wav').waitFor();
check('a pack takes real audio and refuses what is not audio or is too long', (await modal(ada).locator('.list .beat').count()) === 1);
await modal(ada).getByRole('button', { name: 'Publish pack' }).click();
check('and can be published with its license', await toast(ada, /Pack published/) && /CC0-1\.0 · credit Ada L\./.test((await modal(ada).locator('.card').textContent())!));

// ---- a second person: like, remix with credit, use a pack, report ----
const bob = await visitor('bob');
await tab(bob, 'Gallery');
await beatRow(bob, 'First light').waitFor();
await beatRow(bob, 'First light').getByRole('button', { name: 'Like First light' }).click();
await bob.waitForFunction(() => /♥ 1/.test(document.querySelector('.modal .beat')?.textContent ?? ''));
check('someone else can like a beat', (await beatRow(bob, 'First light').getByRole('button', { name: 'Like First light' }).getAttribute('aria-pressed')) === 'true');
await beatRow(bob, 'First light').getByRole('button', { name: /^Remix/ }).click();
await bob.waitForSelector('.modal', { state: 'detached' });
await bob.waitForSelector('.cell.ph', { timeout: 6000 }).catch(() => {});
check('remixing opens a copy in the editor and plays it', (await bob.locator('.cell.ph').count()) > 0 && (await bob.locator('.cell[data-t="0"][data-s="0"]').getAttribute('class'))!.includes('on'));
await bob.keyboard.press('Space');
await bob.locator('.cell[data-t="1"][data-s="2"]').click();
await bob.getByRole('button', { name: 'Community' }).click();
await bob.waitForSelector('.modal');
await modal(bob).getByRole('button', { name: 'Publish' }).click();
const credit = (await modal(bob).locator('.card').textContent())!;
await bob.getByLabel('Title').fill('Second light');
await modal(bob).getByRole('button', { name: 'Publish', exact: true }).click();
await beatRow(bob, 'Second light').waitFor();
check('publishing the remix credits the original', /remix of “First light” by ada/.test(credit) && /remix of “First light” by ada/.test((await beatRow(bob, 'Second light').textContent())!));
const first = (await beatRow(bob, 'First light').textContent())!;
check('the original counts the play and the remix', /▶ 1/.test(first) && /Remix · 1/.test(first), first.replace(/\s+/g, ' '));
await modal(bob).locator('.seg button', { hasText: 'Liked' }).click();
await bob.waitForTimeout(400);
check('the gallery can be sorted by likes', (await modal(bob).locator('.beat b').first().textContent()) === 'First light');
await bob.getByLabel('Search beats').fill('second');
await bob.getByLabel('Search beats').press('Enter');
await bob.waitForFunction(() => document.querySelectorAll('.modal .beat').length === 1);
check('and searched', (await modal(bob).locator('.beat b').first().textContent()) === 'Second light');
await bob.getByLabel('Search beats').fill('');
await bob.getByLabel('Search beats').press('Enter');
await modal(bob).locator('.beat .link', { hasText: 'ada' }).first().click();
await modal(bob).locator('.who').waitFor();
check('a profile shows a person and their beats', /@ada/.test((await modal(bob).locator('.who').textContent())!) && /1 beats · 1 plays · 1 likes/.test((await modal(bob).locator('.who').textContent())!)
  && (await modal(bob).locator('.beat').count()) === 1);
await modal(bob).getByRole('button', { name: 'All beats' }).click();

await tab(bob, 'Sample packs');
await beatRow(bob, 'Clicks').getByRole('button', { name: 'Open' }).click();
await beatRow(bob, 'blip.wav').getByRole('button', { name: /^Use on/ }).click();
check('a sample from a pack can be put on a track, with its license shown', await toast(bob, /blip\.wav from “Clicks” \(CC0-1\.0, Ada L\.\)/));
await bob.keyboard.press('Escape');
check('the track now plays that sample', (await bob.locator('.row.sel .name b').textContent()) === 'BLIP');

await bob.getByRole('button', { name: 'Community' }).click();

await bob.waitForSelector('.modal');
await beatRow(bob, 'First light').getByRole('button', { name: 'Report First light' }).click();
await bob.getByLabel('Reason').selectOption('copyright');
await bob.getByLabel('Details').fill('this is my melody');
await modal(bob).getByRole('button', { name: 'Send report' }).click();
check('a beat can be reported', await toast(bob, /moderator will take a look/));

// ---- moderation ----
const boss = await visitor('boss');
await tab(boss, 'Moderation');
await beatRow(boss, 'First light').waitFor();
check('an admin sees the report in the queue', /copyright · reported by @bob/.test((await beatRow(boss, 'First light').textContent())!) && /this is my melody/.test((await beatRow(boss, 'First light').textContent())!));
await boss.getByLabel('Moderator note').fill('checking');
await beatRow(boss, 'First light').getByRole('button', { name: 'Hide' }).click();
await boss.waitForFunction(() => /No open reports/.test(document.querySelector('.modal')?.textContent ?? ''));
await tab(bob, 'My saves'); await tab(bob, 'Gallery');
await bob.waitForTimeout(500);
check('a hidden beat disappears from the gallery for everyone else', (await beatRow(bob, 'First light').locator('.playb').count()) === 0 && (await beatRow(bob, 'Second light').count()) === 1);
await tab(ada, 'Gallery');
await ada.waitForFunction(() => /hidden by a moderator/.test(document.querySelector('.modal')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
check('but its author still sees it, marked as hidden', /hidden by a moderator/.test((await beatRow(ada, 'First light').textContent())!));
await modal(boss).locator('.seg button', { hasText: 'Resolved' }).click();
await beatRow(boss, 'First light').waitFor();
check('the action is logged', /beat\.hide|hide/.test((await modal(boss).locator('.log').textContent())!) && /checking/.test((await modal(boss).locator('.log').textContent())!));
await beatRow(boss, 'First light').getByRole('button', { name: 'Unhide' }).click();
await tab(bob, 'My saves'); await tab(bob, 'Gallery');
await beatRow(bob, 'First light').waitFor({ timeout: 5000 }).catch(() => {});
check('and can be undone', (await beatRow(bob, 'First light').locator('.playb').count()) >= 1);

// ---- account ----
await tab(bob, 'bob');
await bob.getByLabel('Display name').fill('Bobby');
await modal(bob).getByRole('button', { name: 'Save profile' }).click();
await modal(bob).getByRole('tab', { name: 'Bobby' }).waitFor();
await bob.reload();
await bob.waitForSelector('.cell');
await bob.getByRole('button', { name: 'Community' }).click();
await bob.waitForSelector('.modal');
check('the session and profile survive a reload', (await modal(bob).getByRole('tab', { name: 'Bobby' }).count()) === 1);
await tab(bob, 'Bobby');
await modal(bob).getByRole('button', { name: 'Delete account' }).click();
await modal(bob).getByRole('button', { name: 'Yes, delete everything' }).click();
check('an account can be deleted, along with what it published', await toast(bob, /has been deleted/));
await tab(ada, 'My saves'); await tab(ada, 'Gallery');
await ada.waitForTimeout(500);
check('its beats are gone from the gallery', (await beatRow(ada, 'Second light').count()) === 0 && (await beatRow(ada, 'First light').count()) >= 1);
await tab(ada, 'ada');
await modal(ada).getByRole('button', { name: 'Sign out' }).click();
await modal(ada).getByRole('button', { name: 'Development sign-in' }).waitFor({ timeout: 5000 }).catch(() => {});
check('signing out goes back to the sign-in options', await modal(ada).getByRole('button', { name: 'Development sign-in' }).isVisible());

// ---- the server going away ----
await server.app.close();
await ada.reload();
await ada.waitForSelector('.cell');
await ada.keyboard.press('Space');
await ada.waitForSelector('.cell.ph');
check('if the server is down, the app still starts and plays', (await ada.locator('.cell.ph').count()) > 0);
await ada.getByRole('button', { name: 'Community' }).click();
await ada.waitForSelector('.modal');
check('and says it could not reach the server', await modal(ada).getByText('Could not reach').isVisible());

// the server is taken down on purpose above; Firefox reports that as a blocked cross-origin request
const real = b.errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR|Cross-Origin Request Blocked.*CORS request did not succeed|NetworkError/.test(e));
check('no errors in the console', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  check('test script ran to the end', false, String(e).split('\n')[0]);
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
