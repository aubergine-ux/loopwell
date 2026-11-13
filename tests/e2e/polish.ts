// End-to-end check of the polish pass: every control has a name a screen reader can say and can be reached
// from the keyboard, the high-contrast theme and reduced motion work, and every screen fits a phone.
// Run with: npm run test:polish   (set SHOTS=dir to keep screenshots)

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
const focused = (page: Page) => page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.className.toString().split(' ')[0]}|${e.getAttribute('aria-label') ?? e.textContent?.trim().slice(0, 30)}`; });

/** Everything on screen that can be operated, and whether it has a name and can take focus. Run in the page. */
const AUDIT = `(() => {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=slider], [role=radio], [role=tab], [role=option], [role=gridcell], [role=application], [tabindex]:not([tabindex="-1"])';
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const out = { unnamed: [], total: 0, unreachable: [] };
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
    if (el.closest('[aria-hidden=true]')) continue;
    out.total++;
    let name = el.getAttribute('aria-label') || '';
    const by = el.getAttribute('aria-labelledby');
    if (!name && by) name = by.split(' ').map((id) => text(document.getElementById(id) || el)).join(' ');
    if (!name && el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) name = text(l); }
    if (!name && el.closest('label')) name = text(el.closest('label'));
    if (!name && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) name = text(el);
    if (!name) name = el.getAttribute('title') || el.dataset.tip || '';
    if (!name) out.unnamed.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.') + ' in ' + (el.closest('[class]:not(' + el.tagName + ')')?.className ?? ''));
    // parts of a composite widget (a grid, a list) are reached with the arrow keys from the one that takes focus
    const composite = el.closest('[role=grid], [role=listbox], [role=application]');
    const focusable = el.tabIndex >= 0 && !el.disabled;
    if (!focusable && !el.disabled && !composite && el.getAttribute('role') !== 'gridcell') out.unreachable.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' "' + name.slice(0, 30) + '"');
  }
  return out;
})()`;

/** Does the page fit the screen, and is everything big enough to tap? Run in the page. */
const FIT = `(() => {
  // a page that is too wide makes a phone zoom out to fit it, so measure against the screen itself
  const wide = Math.min(innerWidth, screen.width);
  const out = { overflow: document.documentElement.scrollWidth - wide, small: [], clipped: [] };
  const dialog = document.querySelector('.modal, .palette');
  for (const el of document.querySelectorAll('button, a[href], select, input, [role=slider], [role=button], [role=radio], [role=tab]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden' || el.closest('[aria-hidden=true]')) continue;
    if (dialog && !dialog.contains(el)) continue; // what is behind an open dialog can't be used
    const label = el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) + '"';
    // WCAG 2.2: at least 24 by 24 CSS pixels (checkboxes and range inputs draw their own target)
    // links and buttons that sit in a line of text are let off, as the guideline lets them off
    const inline = el.classList.contains('link') || (el.tagName === 'A' && !!el.closest('p'));
    if ((r.width < 23.5 || r.height < 23.5) && !inline && !(el.tagName === 'INPUT' && /checkbox|radio|range/.test(el.type))) out.small.push(label + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    // off the edge of the screen, unless it is inside something that scrolls sideways
    let p = el.parentElement, scrolls = false;
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) { scrolls = true; break; } p = p.parentElement; }
    if (!scrolls && (r.right > wide + 1 || r.left < -1)) out.clipped.push(label);
  }
  return out;
})()`;

/** The lowest contrast between any piece of text and what is behind it. Run in the page. */
const CONTRAST = `(() => {
  // colours come back as rgb(255, 0, 0) or, for mixed ones, color(srgb 1 0 0)
  const lum = (c) => { const k = c.startsWith('color(') ? 255 : 1; const [r, g, b] = c.match(/\\d+(\\.\\d+)?/g).map(Number).map((v) => { v = v * k / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\\(.*, 0\\)|transparent/.test(c)) return c; e = e.parentElement; } return 'rgb(0,0,0)'; };
  let worst = 99, where = '';
  for (const el of document.querySelectorAll('button, .label, b, span, small, p, kbd, select, input, h3, h4')) {
    if (!el.getClientRects().length || !(el.textContent || '').trim() || el.children.length) continue;
    const cs = getComputedStyle(el);
    if (+cs.opacity < 1 || el.closest('[disabled]')) continue;
    const a = lum(cs.color), b = lum(bgOf(el));
    const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (r < worst) { worst = r; where = el.tagName + '.' + String(el.className).split(' ')[0] + ' "' + el.textContent.trim().slice(0, 16) + '" ' + cs.color + ' on ' + bgOf(el); }
  }
  return { worst: Math.round(worst * 10) / 10, where };
})()`;

interface Screen { name: string; go: (page: Page) => Promise<void> }
const tab = (name: string) => async (page: Page) => { await page.getByRole('tab', { name, exact: true }).click(); };
const view = (name: string) => async (page: Page) => { await page.locator('.seg.view').getByRole('button', { name, exact: true }).click(); };
const modal = (open: (page: Page) => Promise<void>, then?: (page: Page) => Promise<void>) => async (page: Page) => { await open(page); await page.waitForSelector('.modal, .palette'); if (then) await then(page); };
const row = (i: number) => async (page: Page) => { await page.locator(`.row[data-row="${i}"] .name`).click(); };

const SCREENS: Screen[] = [
  { name: 'pattern, drum sound', go: async (p) => { await view('Pattern')(p); await row(0)(p); await tab('Sound')(p); } },
  { name: 'synth sound', go: async (p) => { await row(7)(p); await tab('Sound')(p); } },
  { name: '808 sound', go: async (p) => { await row(6)(p); await p.locator('.sound .seg').getByRole('button', { name: '808' }).click(); } },
  { name: 'drum synth sound', go: async (p) => { await row(1)(p); await p.locator('.sound .seg').getByRole('button', { name: 'Knobs' }).click(); } },
  { name: 'keys', go: async (p) => { await row(7)(p); await tab('Keys')(p); } },
  { name: 'tools', go: async (p) => { await p.locator('.cell[data-t="0"][data-s="0"]').click({ button: 'right' }); } },
  { name: 'rack', go: async (p) => { await tab('Rack')(p); await p.getByRole('button', { name: 'Add EQ' }).click(); } },
  { name: 'mix', go: async (p) => { await tab('Mix')(p); await p.getByLabel('Where KICK goes').selectOption({ label: '→ New group' }); } },
  { name: 'fx', go: tab('FX') },
  { name: 'song panel', go: tab('Song') },
  { name: 'song view', go: view('Song') },
  { name: 'pads view', go: view('Pads') },
  { name: 'live view', go: view('Live') },
  { name: 'share', go: modal(async (p) => { await view('Pattern')(p); await p.getByRole('button', { name: 'Share' }).click(); }) },
  { name: 'export', go: modal((p) => p.getByRole('button', { name: 'Export', exact: true }).click(), (p) => p.locator('.modal').getByRole('radio', { name: 'MP3' }).click()) },
  { name: 'help', go: modal((p) => p.getByRole('button', { name: 'Shortcuts and help' }).click()) },
  { name: 'my beats', go: modal((p) => p.getByRole('button', { name: 'Beats', exact: true }).click(), (p) => p.getByRole('radio', { name: 'My beats' }).click()) },
  { name: 'templates', go: modal((p) => p.getByRole('button', { name: 'Beats', exact: true }).click(), (p) => p.getByRole('radio', { name: 'Templates' }).click()) },
  { name: 'demos', go: modal((p) => p.getByRole('button', { name: 'Beats', exact: true }).click(), (p) => p.getByRole('radio', { name: 'Demos' }).click()) },
  { name: 'sounds', go: modal(async (p) => { await row(0)(p); await tab('Sound')(p); await p.locator('.sampler').getByRole('button', { name: 'Browse' }).click(); }) },
  { name: 'presets', go: modal(async (p) => { await row(7)(p); await tab('Sound')(p); await p.getByRole('button', { name: 'Presets' }).click(); }) },
  // opened by name from Find anything, which is how a phone gets to them
  { name: 'history', go: modal(async (p) => { await p.getByRole('button', { name: 'Find anything' }).click(); await p.keyboard.type('history every'); await p.keyboard.press('Enter'); await p.waitForSelector('.modal ol'); }) },
  { name: 'palette', go: modal((p) => p.getByRole('button', { name: 'Find anything' }).click()) },
  { name: 'community', go: modal(async (p) => { await p.getByRole('button', { name: 'Find anything' }).click(); await p.keyboard.type('community gallery'); await p.keyboard.press('Enter'); await p.waitForFunction(() => document.querySelector('.modal h2')?.textContent === 'Community'); }) },
];

const small = new Set<string>();
async function sweep(page: Page, what: 'audit' | 'fit', prefix: string): Promise<void> {
  for (const s of SCREENS) {
    await page.keyboard.press('Escape');
    try { await s.go(page); } catch (e) { check(`${prefix}${s.name}: could be opened`, false, String(e).split('\n')[0]); continue; }
    await page.waitForTimeout(150);
    if (what === 'audit') {
      const r = (await page.evaluate(AUDIT)) as { unnamed: string[]; total: number; unreachable: string[] };
      check(`${prefix}${s.name}: all ${r.total} controls have a name`, r.unnamed.length === 0, [...new Set(r.unnamed)].slice(0, 6).join(' ; '));
      check(`${prefix}${s.name}: and can be reached from the keyboard`, r.unreachable.length === 0, [...new Set(r.unreachable)].slice(0, 6).join(' ; '));
    } else {
      const r = (await page.evaluate(FIT)) as { overflow: number; small: string[]; clipped: string[] };
      await shot(page, `phone-${s.name.replace(/[^a-z0-9]+/g, '-')}`);
      check(`${prefix}${s.name}: fits the screen`, r.overflow <= 1 && r.clipped.length === 0, `${r.overflow > 1 ? `page is ${r.overflow}px too wide; ` : ''}${[...new Set(r.clipped)].slice(0, 5).join(' ; ')}`);
      for (const x of r.small) small.add(x);
    }
  }
  await page.keyboard.press('Escape');
}

const b = await launch();
const { page, url } = b;
try {
  await page.addInitScript(() => localStorage.setItem('loopwell:prefs', JSON.stringify({ toured: true })));
  await page.goto(url);
  await page.waitForSelector('.cell');

  // ---- names and reachability, on every screen ----
  await sweep(page, 'audit', '');

  // ---- keyboard only ----
  await page.reload();
  await page.waitForSelector('.cell');
  await cell(page, 0, 0).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  check('the step grid can be walked and edited with the arrow keys and Enter', (await focused(page)).includes('SNARE step 3') && (await cell(page, 1, 2).getAttribute('class'))!.includes(' on'));
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  check('plus and minus change how hard a step hits', (await cell(page, 1, 2).getAttribute('aria-label'))!.includes('velocity 80'), (await cell(page, 1, 2).getAttribute('aria-label'))!);
  await page.keyboard.press('Shift+Enter');
  check('Shift+Enter opens the step\'s extras', (await page.locator('.tools h3 small').first().textContent())!.includes('SNARE · 3'));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  check('only one step is in the tab order, so Tab leaves the grid', !(await focused(page)).startsWith('cell'), await focused(page));
  await page.keyboard.press('Shift+Tab');
  check('and comes back to where it was', (await focused(page)).includes('SNARE step 3'));
  const track = await page.evaluate(() => document.querySelector('.row.sel')?.getAttribute('data-row'));
  check('moving through the grid selects the track', track === '1');

  // someone using the mouse keeps the shortcuts they had: after clicking a step, arrows pick track and pattern
  await cell(page, 4, 9).click();
  await cell(page, 4, 9).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  check('after a click, the arrow keys still choose the track and the pattern', (await page.evaluate(() => document.querySelector('.row.sel')?.getAttribute('data-row'))) === '5'
    && (await page.locator('.pats .pat.on').textContent()) === 'B');
  await page.keyboard.press('ArrowLeft');

  // piano roll
  await page.locator('.row[data-row="7"] .name').click();
  await page.getByRole('tab', { name: 'Keys', exact: true }).click();
  await page.keyboard.press('Shift'); // the keyboard is in use again, as it would be for someone tabbing here
  await page.locator('.lane').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const said = await page.locator('.roll .sr').textContent();
  check('the piano roll can be played from the keyboard, and says where the cursor is', (await page.locator('.note').count()) === 1 && /step 2, note 3 steps long/.test(said ?? ''), said ?? '');
  await page.keyboard.press('Delete');
  check('and a note removed', (await page.locator('.note').count()) === 0);

  // pads and transport
  await page.keyboard.press('Shift');
  await page.locator('.pad[data-pad="0"]').focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(150);
  const hit = await page.locator('.row[data-row="0"] .meter i').evaluate((el) => (el as HTMLElement).style.transform);
  await page.keyboard.up('Enter');
  check('Enter plays a pad', /scaleX\((0\.[0-9]*[1-9]|1)/.test(hit), hit);

  // song view
  await page.locator('.seg.view').getByRole('button', { name: 'Song', exact: true }).click();
  await page.keyboard.press('Shift');
  await page.locator('.clip').first().focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const clip = await page.locator('.clip').first().getAttribute('aria-label');
  check('a clip can be moved and stretched from the keyboard', /bar 2, 32 steps/.test(clip ?? ''), clip ?? '');
  await page.keyboard.press('Delete');
  check('and deleted', (await page.locator('.clip').count()) === 7);
  await page.keyboard.press('Control+z');
  await page.locator('.ruler').focus();
  await page.keyboard.press('ArrowRight');
  check('the song position moves with the arrow keys', (await page.locator('.ruler').getAttribute('aria-valuenow')) === '16');
  await page.keyboard.press('Home');
  await page.locator('.seg.view').getByRole('button', { name: 'Pattern', exact: true }).click();

  // dialogs keep focus and give it back
  await page.getByRole('button', { name: 'Export', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal');
  let inside = true;
  for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); inside &&= await page.evaluate(() => !!document.activeElement?.closest('.modal')); }
  check('Tab stays inside an open dialog', inside);
  await page.keyboard.press('Escape');
  check('and closing it returns focus to the button that opened it', (await focused(page)).includes('Export'));
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  check('keyboard focus is always visible', ring === 'solid', ring);

  // ---- high contrast ----
  await page.keyboard.press('Control+k');
  await page.keyboard.type('high contrast');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400); // colours fade from one theme to the next
  const ratio = (await page.evaluate(CONTRAST)) as { worst: number; where: string };
  await shot(page, 'contrast');
  check('the high-contrast theme keeps every piece of text at 7:1 or better', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'contrast' && ratio.worst >= 7, `${ratio.worst}:1 at ${ratio.where}`);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.waitForTimeout(400);
  await shot(page, 'contrast-playing');
  check('and the playhead shows in it', (await page.locator('.headcol').evaluate((el) => getComputedStyle(el).opacity)) === '1');
  await page.keyboard.press('Space');
  await page.keyboard.press('Shift+c');

  // a system that asks for more contrast gets it without being asked
  const hc = await b.browser.newContext({ viewport: { width: 1200, height: 800 }, contrast: 'more' } as never);
  const hp = await hc.newPage();
  await hp.goto(url);
  await hp.waitForSelector('.cell');
  check('a system set to high contrast gets the high-contrast theme on a first visit', (await hp.evaluate(() => document.documentElement.dataset.theme)) === 'contrast');
  await hc.close();

  // ---- reduced motion ----
  const rm = await b.browser.newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
  const rp = await rm.newPage();
  await rp.goto(url);
  await rp.waitForSelector('.cell');
  await rp.keyboard.press('Space');
  await rp.waitForSelector('.cell.ph');
  await rp.waitForTimeout(900);
  const moving = await rp.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().duration as number) > 5).length);
  check('with reduced motion the beat plays and the playhead moves, but nothing bounces or pulses', moving === 0 && (await rp.locator('.cell.ph').count()) > 0, `${moving} animations running`);
  await rm.close();
  await page.keyboard.press('Shift+Slash');
  await page.getByLabel('Reduce motion').check();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.waitForTimeout(900);
  const still = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().duration as number) > 5).length);
  check('and it can be switched on in Loopwell itself', still === 0 && (await page.evaluate(() => document.documentElement.dataset.calm)) === '', `${still} animations running`);
  await page.keyboard.press('Space');

  check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}

// ---- a phone ----
const phone = await launch({ width: 390, height: 844, touch: true, scale: 2 });
try {
  const pp = phone.page;
  await pp.addInitScript(() => localStorage.setItem('loopwell:prefs', JSON.stringify({ toured: true })));
  await pp.goto(phone.url);
  await pp.waitForSelector('.cell');
  await sweep(pp, 'fit', 'phone, ');
  check('phone: every control on every screen is big enough to tap (24 px or more each way)', small.size === 0, [...new Set([...small].map((x) => x.replace(/"[^"]*"/, '').replace(/\s+/g, ' ')))].slice(0, 40).join(' ; '));
  await pp.locator('.seg.view').getByRole('button', { name: 'Pattern', exact: true }).click();
  await pp.locator('.tbtn.play').tap();
  await pp.waitForSelector('.cell.ph', { timeout: 5000 });
  await pp.locator('.cell[data-t="1"][data-s="2"]').tap();
  check('phone: it plays, and a tap sets a step', (await pp.locator('.cell[data-t="1"][data-s="2"]').getAttribute('class'))!.includes(' on'));
  await pp.locator('.tbtn.play').tap();
  check('phone: no errors in the console', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('phone: ran to the end', false, String(e).slice(0, 1200));
} finally {
  await phone.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
