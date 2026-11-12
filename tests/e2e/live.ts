// End-to-end test of live sessions: three browsers on one beat, through the
// real relay. Run with: npm run test:live

import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { attachRealtime } from '../../server/src/realtime';
import { rig } from '../../server/test/helpers';

let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

const b = await launch();
const origin = new URL(b.url).origin;
const server = await rig({ APP_ORIGINS: origin });
const rt = attachRealtime(server.app);
await server.app.listen({ port: 0, host: '127.0.0.1' });
const api = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;

const cell = (p: Page, t: number, s: number) => p.locator(`.cell[data-t="${t}"][data-s="${s}"]`);
const isOn = async (p: Page, t: number, s: number) => (await cell(p, t, s).getAttribute('class'))!.includes('on');
const until = async (fn: () => Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const toast = (p: Page, re: RegExp) => until(async () => re.test((await p.locator('.toast').textContent().catch(() => '')) ?? ''));
const pos = async (p: Page) => (await p.locator('.lcd .info div:nth-child(2) b').textContent()) ?? '';
const steps = (label: string) => { const [, beat, six] = label.split('.').map(Number); return (beat - 1) * 4 + six - 1; };
const peers = (p: Page) => p.locator('.livetab').textContent();

async function open(name: string): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await b.browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => b.errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|ERR_INTERNET_DISCONNECTED/.test(m.text())) b.errors.push(`${name}: ${m.text()}`); });
  return { page, ctx };
}
async function joinBy(link: string, name: string): Promise<{ page: Page; ctx: BrowserContext }> {
  const o = await open(name);
  await o.page.goto(link);
  await o.page.getByLabel('Your name').fill(name);
  await o.page.getByRole('button', { name: 'Join', exact: true }).click();
  await o.page.waitForSelector('.livetab');
  return o;
}

try {
// ---- start a session ----
const { page: ada } = await open('ada');
await ada.goto(`${b.url}#server=${api}`);
await ada.waitForSelector('.cell');
await cell(ada, 1, 6).click(); // something that tells this beat apart from a fresh one
await ada.getByRole('button', { name: 'Share' }).click();
await ada.getByLabel('Your name').fill('ada');
await ada.getByRole('button', { name: 'Start a live session' }).click();
await ada.waitForSelector('.livetab');
await until(async () => /Live · 1/.test((await peers(ada))!));
const link = await ada.getByLabel('Invite link').inputValue();
check('starting a session gives an invite link', /#live=[a-z0-9]{10}&server=/.test(link) && /ada/.test((await ada.locator('.peers').textContent())!) && /host/.test((await ada.locator('.peers').textContent())!));

// ---- someone joins by the link ----
const { page: bob, ctx: bobCtx } = await joinBy(link, 'bob');
check('the invite link asks for a name, then opens the host\'s beat', (await until(() => isOn(bob, 1, 6))) && (await bob.evaluate(() => location.hash)) === '');
check('both see who is there', (await until(async () => /Live · 2/.test((await peers(ada))!))) && /Live · 2/.test((await peers(bob))!));

// ---- edits go both ways, as they happen ----
await cell(bob, 2, 10).click();
check('a guest\'s edit shows up for the host', await until(() => isOn(ada, 2, 10), 2000));
await ada.keyboard.press('=');
check('and the host\'s for the guest', await until(async () => (await bob.locator('.lcd .num').textContent()) === '121', 2000));
await Promise.all([
  (async () => { await cell(ada, 4, 3).click(); await cell(ada, 4, 4).click(); })(),
  (async () => { await cell(bob, 5, 9).click(); await cell(bob, 5, 10).click(); })(),
]);
const merged = () => Promise.all([isOn(ada, 4, 3), isOn(ada, 5, 9), isOn(bob, 4, 4), isOn(bob, 5, 10), isOn(ada, 5, 10), isOn(bob, 4, 3)]).then((x) => x.every(Boolean));
check('edits made at the same moment both stick, on both sides', await until(merged, 3000),
  JSON.stringify(await Promise.all([isOn(ada, 4, 3), isOn(ada, 4, 4), isOn(ada, 5, 9), isOn(ada, 5, 10), isOn(bob, 4, 3), isOn(bob, 4, 4), isOn(bob, 5, 9), isOn(bob, 5, 10)])));
await bob.locator('.row[data-row="6"] .name').click();
await bob.getByRole('tab', { name: 'Sound' }).click();
await bob.getByRole('button', { name: 'Presets' }).click();
await bob.locator('.modal .load', { hasText: 'Acid Line' }).click();
await bob.keyboard.press('Escape');
await ada.locator('.row[data-row="6"] .name').click();
await ada.getByRole('tab', { name: 'Sound' }).click();
check('a whole sound change travels too', await until(async () => (await ada.locator('.synth .stepper b').nth(1).textContent()) === '1' && (await ada.locator('.synth').count()) === 1, 3000));
await ada.keyboard.press('Control+z');
check('undo is switched off in a session, with an explanation', await toast(ada, /Undo is off during a live session/));

// ---- cursors and name tags ----
const dev = (await bob.locator('.device').boundingBox())!;
// point at a step: the host should see the pointer on that same step, whatever panel each of them has open
const target = (await cell(bob, 3, 12).boundingBox())!;
await bob.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
const same = (await cell(ada, 3, 12).boundingBox())!;
const onStep = async () => { const c = await ada.locator('.cursor[data-peer="bob"]').boundingBox(); return !!c && Math.abs(c.x - (same.x + same.width / 2)) < 8 && Math.abs(c.y - (same.y + same.height / 2)) < 8; };
check('the host sees the guest\'s cursor, with their name, on the step they point at', (await until(onStep, 3000)) && /bob/.test((await ada.locator('.cursor[data-peer="bob"]').textContent())!),
  JSON.stringify([await ada.locator('.cursor[data-peer="bob"]').boundingBox(), same]));
// and in the lower panel, when both have the same tab open
const knob = (await bob.locator('.synth .stepper').first().boundingBox())!;
await bob.mouse.move(knob.x + 10, knob.y + 10, { steps: 3 });
const sameKnob = (await ada.locator('.synth .stepper').first().boundingBox())!;
check('and on the same control in the panel below', await until(async () => { const c = await ada.locator('.cursor[data-peer="bob"]').boundingBox(); return !!c && Math.abs(c.x - (sameKnob.x + 10)) < 10 && Math.abs(c.y - (sameKnob.y + 10)) < 10; }, 3000));
await bob.keyboard.press('v');
await bob.mouse.move(dev.x + dev.width * 0.4, dev.y + dev.height * 0.4, { steps: 3 });
check('and that they have gone to the song view', await until(async () => /bob · song/.test((await ada.locator('.cursor[data-peer="bob"]').textContent()) ?? '')));
check('which is theirs alone: the host stays in the pattern view', (await ada.locator('.cell').count()) > 0 && (await bob.locator('.tl').count()) === 1);
await bob.keyboard.press('v');

// ---- chat and activity ----
await bob.locator('.livetab').click();
await bob.getByLabel('Message').fill('hello from bob');
await bob.getByRole('button', { name: 'Send' }).click();
check('a chat message reaches the other person, flagged as unread', await until(async () => /Live · 2\s*1/.test((await peers(ada))!.replace(/\s+/g, ' '))));
await ada.locator('.livetab').click();
check('and reads properly once opened', /bob\s+hello from bob/.test((await ada.locator('.feed').textContent())!.replace(/\s+/g, ' ')) && !/Live · 2\s*1/.test((await peers(ada))!.replace(/\s+/g, ' ')));
await ada.locator('.right .seg button', { hasText: 'Activity' }).click();
const log = async () => ((await ada.locator('.feed').textContent()) ?? '').replace(/\s+/g, ' ');
check('the activity log says who changed what', (await until(async () => /bob CLAP: pattern A, PERC: pattern A, BASS: sound/.test(await log()) && /ada tempo 120 → 121, OPEN: pattern A/.test(await log()), 4000)), await log());

// ---- playing together ----
await ada.keyboard.press('Space');
await Promise.all([ada.waitForSelector('.cell.ph'), bob.waitForSelector('.cell.ph')]);
check('pressing play starts everyone', (await ada.locator('.tbtn.play.on').count()) === 1 && (await bob.locator('.tbtn.play.on').count()) === 1);
// Compare where two people are, several times over. Reading two pages takes a moment on a busy
// machine, so judge by the typical gap and allow the odd reading to be one step further out.
const apart = async (x: Page, y: Page, n: number) => {
  const gaps: number[] = [];
  for (let i = 0; i < n; i++) {
    const [a, c] = await Promise.all([pos(x), pos(y)]);
    const d = Math.abs(steps(a) - steps(c));
    gaps.push(Math.min(d, 16 - d));
    await new Promise((r) => setTimeout(r, 170));
  }
  gaps.sort((p, q) => p - q);
  return { typical: gaps[gaps.length >> 1], worst: gaps[gaps.length - 1] };
};
const together = await apart(ada, bob, 13);
check('and they stay on the same step', together.typical <= 1 && together.worst <= 2, `typically ${together.typical}, at most ${together.worst} step apart over 2 seconds`);
const { page: cy } = await joinBy(link, 'cy');
await cy.waitForSelector('.cell.ph', { timeout: 6000 }).catch(() => {});
const late = await apart(ada, cy, 9);
check('someone who joins mid-song comes in at the right place', (await cy.locator('.cell.ph').count()) > 0 && late.typical <= 1 && late.worst <= 2, `typically ${late.typical}, at most ${late.worst} step apart`);
await bob.keyboard.press('Space');
check('anyone can stop it, for everyone', await until(async () => (await ada.locator('.cell.ph').count()) + (await bob.locator('.cell.ph').count()) + (await cy.locator('.cell.ph').count()) === 0, 3000));

// ---- host controls ----
await ada.locator('.left .seg button, .right .seg button', { hasText: 'Chat' }).click();
await ada.getByRole('button', { name: 'Lock KICK' }).click();
await until(async () => (await bob.locator('.row[data-row="0"] .locked').count()) === 1);
await cell(bob, 0, 2).click();
check('a locked track can\'t be changed by guests', (await toast(bob, /KICK is locked by the host/)) && (await until(async () => !(await isOn(bob, 0, 2)), 2000)) && !(await isOn(ada, 0, 2)));
await cell(bob, 3, 1).click();
await cell(ada, 0, 2).click();
check('other tracks can, and the host can still edit the locked one', (await until(() => isOn(ada, 3, 1), 2000)) && (await until(() => isOn(bob, 0, 2), 2000)));
await ada.getByRole('button', { name: 'Lock KICK' }).click();
await ada.getByRole('button', { name: 'View-only for guests' }).click();
await until(async () => (await bob.locator('.badge').count()) === 1);
await cell(bob, 7, 7).click();
const sawToast = await toast(bob, /view-only/);
check('in a view-only session guests can look but not touch', sawToast && (await until(async () => !(await isOn(bob, 7, 7)), 2000)) && !(await isOn(ada, 7, 7)),
  JSON.stringify([sawToast, await isOn(bob, 7, 7), await isOn(ada, 7, 7), await bob.locator('.toast').textContent().catch(() => '')]));
await ada.getByRole('button', { name: 'View-only for guests' }).click();
await until(async () => (await bob.locator('.badge').count()) === 0);
await cell(bob, 7, 7).click();
check('until the host opens it up again', await until(() => isOn(ada, 7, 7), 2000));
await ada.getByRole('button', { name: 'Remove cy from the session' }).click();
check('the host can remove someone', (await toast(cy, /host removed you/)) && (await until(async () => (await cy.locator('.livetab').count()) === 0)) && (await until(async () => /Live · 2/.test((await peers(ada))!))));
await cy.goto('about:blank');
await cy.goto(link);
await cy.getByLabel('Your name').fill('cy again');
await cy.getByRole('button', { name: 'Join', exact: true }).click();
check('who then can\'t get back in', await toast(cy, /host removed you/));

// ---- a dropped connection ----
await bobCtx.setOffline(true);
for (const room of rt.rooms.values()) for (const p of room.peers.values()) if (p.name === 'bob') p.ws.terminate();
await until(async () => /Reconnecting/.test((await bob.locator('.left').textContent()) ?? ''));
check('a guest who loses the connection is told so', /Reconnecting/.test((await bob.locator('.left').textContent()) ?? '') && (await until(async () => /Live · 1/.test((await peers(ada))!))));
await cell(bob, 6, 12).click(); // both keep working while apart
await cell(ada, 2, 14).click();
await bobCtx.setOffline(false);
check('and when it comes back, nothing either side did is lost', (await until(() => isOn(ada, 6, 12), 15000)) && (await until(() => isOn(bob, 2, 14), 3000)) && /Live · 2/.test((await peers(ada))!));

// ---- leaving ----
await bob.locator('.livetab').click();
await bob.getByRole('button', { name: 'Leave', exact: true }).click();
check('leaving keeps the beat, and undo works again', (await until(async () => (await bob.locator('.livetab').count()) === 0)) && (await isOn(bob, 1, 6))
  && (await until(async () => /Live · 1/.test((await peers(ada))!))));
await cell(bob, 1, 6).click();
await bob.keyboard.press('Control+z');
check('edits after leaving stay local', (await isOn(bob, 1, 6)) && (await isOn(ada, 1, 6)));
await ada.getByRole('button', { name: 'End the session for everyone' }).click();
check('the host can end the session', (await until(async () => (await ada.locator('.livetab').count()) === 0)) && rt.rooms.size === 0);
await ada.keyboard.press('Space');
await ada.waitForSelector('.cell.ph');
check('and carry on alone', (await ada.locator('.cell.ph').count()) > 0);

check('no errors in the console', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('test script ran to the end', false, String(e).split('\n')[0]);
} finally {
  await b.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
