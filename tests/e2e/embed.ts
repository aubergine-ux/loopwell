// End-to-end check of the embeddable player against the production build: the
// player is put on a page of another origin, as an iframe and as the web
// component, and played.
// Run with: npm run test:embed   (set SHOTS=dir to keep screenshots)

import { mkdirSync, statSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Frame, Page } from 'playwright-core';
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
const host = (body: string) => `<!doctype html><html><body style="margin:40px;font-family:sans-serif;background:#fff"><h1>Somebody's blog</h1>${body}<p>Words after the player.</p></body></html>`;
async function player(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((x) => x.url().includes('embed.html'));
    if (f) { await f.waitForSelector('#title'); return f; }
    await page.waitForTimeout(100);
  }
  throw new Error(`the player's frame never loaded: ${page.frames().map((x) => x.url()).join(', ')}`);
}
const stateOf = (f: Frame) => f.evaluate(() => document.getElementById('player')!.dataset.state);
// how much of the waveform is drawn in a colour other than the first bar's
const drawn = (f: Frame) => f.evaluate(() => {
  const c = document.getElementById('canvas') as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let tall = 0;
  for (let x = 0; x < c.width; x += 2) { let n = 0; for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 0) n++; if (n > c.height * 0.3) tall++; }
  return tall;
});

// Somebody else's website: a second server, so the player is on a page of a different origin, as it would be.
let body = '';
const site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); });
await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
const blog = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
async function visit(page: Page, html: string): Promise<void> {
  body = html;
  await page.goto('about:blank');
  await page.goto(blog);
}

const b = await launch({ autoplay: false });
const { page, url, errors } = b;
try {
  // the player's own files are small: it must not drag the app in
  const assets = readdirSync('dist/assets');
  const html = (await (await fetch(`${url}embed.html`)).text());
  const scripts = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const bytes = scripts.reduce((n, f) => n + statSync(`dist/assets/${f}`).size, 0);
  check('the player loads a fraction of what the app does', scripts.length > 0 && bytes < 260 * 1024 && !scripts.some((s) => /^index-/.test(s)), `${(bytes / 1024).toFixed(0)} kB of script in ${scripts.length} files, of ${assets.length} built`);

  // get a beat and its embed code from the app
  await page.goto(url);
  await page.waitForSelector('.cell');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'Trap' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const link = await page.locator('#share-url').inputValue();
  await page.locator('.modal summary', { hasText: 'Put a player on a website' }).click();
  const iframeCode = await page.locator('#embed-code').inputValue();
  check('the Share dialog gives iframe code for this beat', iframeCode.startsWith('<iframe src="') && iframeCode.includes(`${url}embed.html#b=${link.split('#b=')[1]}`), iframeCode.slice(0, 70));
  await shot(page, 'embed-share');
  await page.getByRole('radio', { name: 'Web component' }).click();
  const elementCode = await page.locator('#embed-code').inputValue();
  check('and web component code', elementCode.includes(`<script src="${url}player.js" async></script>`) && elementCode.includes('<loopwell-player beat="'));

  // --- as an iframe, on a page of another origin ---
  await visit(page, host(iframeCode.replace('loading="lazy"', '')));
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow != null);
  await page.waitForTimeout(300);
  let f = await player(page);
  await f.waitForSelector('#title');
  check('it shows the name of the beat and its tempo', (await f.textContent('#title')) === 'Trap starter' && /\d+ bpm/i.test((await f.textContent('#meta')) ?? ''), `${await f.textContent('#title')} · ${await f.textContent('#meta')}`);
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'ready', undefined, { timeout: 60000 });
  check('the waveform is drawn once it is in view, before anything is pressed', (await drawn(f)) > 20, `${await drawn(f)} tall columns`);
  check('nothing plays by itself', (await stateOf(f)) === 'ready');
  await shot(page, 'embed-iframe');
  await f.click('#play');
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'playing', undefined, { timeout: 30000 });
  await page.waitForTimeout(1600);
  const time = (await f.textContent('#time')) ?? '';
  check('pressing play plays it, and the time moves', /^0:0[1-9] \/ \d:\d\d$/.test(time), time);
  check('the button becomes a pause button', (await f.getAttribute('#play', 'aria-label')) === 'Pause');
  await shot(page, 'embed-playing');
  await f.click('#play');
  check('pause stops it where it is', (await stateOf(f)) === 'ready' && (await f.getAttribute('#play', 'aria-label')) === 'Play');
  const held = await f.textContent('#time');
  await page.waitForTimeout(400);
  check('and it stays there', (await f.textContent('#time')) === held);

  // seeking: a click on the waveform, then the keyboard
  const box = (await (await f.$('#wave'))!.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  const max = +(await f.getAttribute('#wave', 'aria-valuemax'))!;
  const mid = +(await f.getAttribute('#wave', 'aria-valuenow'))!;
  check('a click on the waveform jumps there', Math.abs(mid - max / 2) <= 1.5, `${mid}s of ${max}s`);
  await f.focus('#wave');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move through it', +(await f.getAttribute('#wave', 'aria-valuenow'))! >= mid + 1);
  await page.keyboard.press('Home');
  check('Home goes back to the start', (await f.getAttribute('#wave', 'aria-valuenow')) === '0');
  await page.keyboard.press('Space');
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'playing');
  check('Space plays', true);
  await page.keyboard.press('Space');

  // the way into the app
  const href = (await f.getAttribute('#open', 'href'))!;
  check('Open in Loopwell points at the app with this beat', href === link, href.slice(0, 60));
  const [popup] = await Promise.all([page.context().waitForEvent('page'), f.click('#open')]);
  await popup.waitForSelector('.cell');
  check('and the beat opens there', (await popup.title()).length > 0 && (await popup.locator('.cell.on, .cell[aria-pressed="true"]').count()) > 0 || (await popup.evaluate(() => location.hash.length > 10)));
  await popup.close();

  // --- themes ---
  await visit(page, host(iframeCode.replace('loading="lazy"', '').replace(/(#b=[^"&]+)/, '$1&amp;theme=night')));
  await page.waitForTimeout(400);
  f = await player(page);
  await f.waitForSelector('#title');
  check('a theme can be asked for', (await f.evaluate(() => document.documentElement.dataset.theme)) === 'night');
  await shot(page, 'embed-night');

  // --- a small frame ---
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(300);
  const fits = await f.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1);
  const inside = await f.evaluate(() => { const o = document.getElementById('open')!.getBoundingClientRect(), p = document.getElementById('player')!.getBoundingClientRect(); return o.right <= p.right - 4 && o.left >= p.left; });
  check('it fits a narrow page without scrolling', fits);
  check('with the way into Loopwell still whole', inside);
  await shot(page, 'embed-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });

  // --- as the web component ---
  await visit(page, host(elementCode));
  await page.waitForFunction(() => !!customElements.get('loopwell-player') && !!document.querySelector('loopwell-player')?.shadowRoot?.querySelector('iframe')?.src);
  await page.waitForTimeout(400);
  f = await player(page);
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'ready', undefined, { timeout: 60000 });
  check('the web component shows the same player', (await f.textContent('#title')) === 'Trap starter');
  await page.evaluate(() => {
    (window as any).__states = [];
    document.querySelector('loopwell-player')!.addEventListener('loopwell-state', (e) => (window as any).__states.push((e as CustomEvent).detail.state));
  });
  // a script may only start sound after the visitor has clicked something on the page
  await page.mouse.click(60, 60);
  await f.click('#play');
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'playing');
  await page.evaluate(() => (document.querySelector('loopwell-player') as any).pause());
  await f.waitForFunction(() => document.getElementById('player')!.dataset.state === 'ready');
  const states = (await page.evaluate(() => (window as any).__states)) as string[];
  check('the page is told what the player is doing, and can pause it', states.includes('playing') && states[states.length - 1] === 'ready', states.join(' → '));
  await shot(page, 'embed-element');

  // --- bad input ---
  await visit(page, host(`<iframe src="${url}embed.html#b=this-is-not-a-beat" width="100%" height="152" style="border:0"></iframe>`));
  await page.waitForTimeout(400);
  f = await player(page);
  await f.waitForSelector('#status');
  check('a broken link says so instead of breaking', (await stateOf(f)) === 'error' && /not a Loopwell beat/.test((await f.textContent('#status')) ?? '') && (await f.isDisabled('#play')));
  await shot(page, 'embed-broken');
  await visit(page, host(`<iframe src="${url}embed.html" width="100%" height="152" style="border:0"></iframe>`));
  await page.waitForTimeout(400);
  f = await player(page);
  check('so does a player with no beat', /no beat/.test((await f.textContent('#status')) ?? ''));

  // the readback warning is about this test looking at the canvas, not about the player
  const real = errors.filter((e) => !/favicon|willReadFrequently/.test(e));
  check('no errors on the page', real.length === 0, real.join(' | '));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
  await shot(page, 'embed-failed');
} finally {
  await b.close();
  site.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
