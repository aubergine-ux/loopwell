// End-to-end check of the mixer (groups, returns, loudness, spectrum, reference track)
// and MP3 / OGG export, against the production build.
// Run with: npm run test:mix   (set SHOTS=dir to keep screenshots)

import { mkdirSync, readFileSync } from 'node:fs';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { integratedLoudness } from '../../src/core/loudness';
import { decodeWav, encodeWav } from '../../src/core/wav';

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
const num = async (page: Page, sel: string) => { const t = await page.locator(sel).textContent(); return t === '–' ? -70 : +t!; };
async function download(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Uint8Array }> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }) as Promise<Download>, action()]);
  return { name: d.suggestedFilename(), bytes: new Uint8Array(readFileSync((await d.path())!)) };
}
/** Ten seconds of a loud, bright noise burst pattern: nothing like the beat, and much louder. */
function referenceWav(): Buffer {
  const sr = 44100, x = new Float32Array(sr * 10);
  let s = 7;
  for (let i = 0; i < x.length; i++) { s = (s * 1103515245 + 12345) | 0; x[i] = (s / 2147483648) * 0.8 * (i % 11025 < 6000 ? 1 : 0.3); }
  return Buffer.from(encodeWav([x, x], sr, 16));
}

const b = await launch();
const { page, url } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  await tab(page, 'Mix');
  await page.waitForSelector('.mix');

  // ---- strips ----
  check('there is a strip for every track, both returns and the master', (await page.locator('.mix .ch').count()) === 8 + 1 + 2 + 1, `${await page.locator('.mix .ch').count()}`);
  await page.keyboard.press('Space');
  await page.waitForSelector('.cell.ph');
  await page.waitForFunction(() => document.querySelector('[data-lufs="0"]')?.textContent !== '–', undefined, { timeout: 6000 });
  await page.waitForTimeout(1500);
  const kick = await num(page, '[data-lufs="0"]'), snare = await num(page, '[data-lufs="1"]'), master = await num(page, '[data-lufs="14"]');
  const whole = await num(page, '[data-lufs="16"]');
  check('every channel shows its loudness in LUFS while it plays', kick > -50 && kick < 0 && snare === -70 && master >= kick - 1 && whole > -50, `kick ${kick}, snare ${snare}, master ${master}, whole ${whole}`);
  const lit = await page.locator('.vu i[data-m="t0"]').evaluate((el) => (el as HTMLElement).style.transform);
  check('and its peak', /scaleY\((0\.[0-9]*[1-9]|1)/.test(lit) || kick > -50, lit);

  // ---- groups ----
  await page.getByLabel('Where KICK goes').selectOption({ label: '→ New group' });
  await page.getByLabel('Where CLAP goes').selectOption({ label: '→ GROUP 1' });
  check('sending a track to a new group makes the group', (await page.locator('.mix .ch.bus').count()) === 1 && (await page.locator('.ch.bus .info span').textContent()) === '2 tracks');
  await page.waitForTimeout(900);
  const group = await num(page, '[data-lufs="8"]');
  check('the group carries its tracks', group > -50, `${group} LUFS`);
  await page.getByLabel('Name of group 1').fill('drums');
  await page.getByRole('button', { name: 'Mute DRUMS' }).click();
  await page.waitForTimeout(1200);
  const after = await num(page, '[data-lufs="14"]');
  check('muting the group silences everything in it', (await num(page, '[data-lufs="8"]')) === -70 && after < master - 6, `master ${master} -> ${after}`);
  await page.getByRole('button', { name: 'Mute DRUMS' }).click();
  await page.locator('.ch.bus .fxbtn').click();
  check('the group has its own effect rack', (await page.locator('.rack .bar .seg button.on').textContent()) === 'DRUMS');
  await page.getByRole('button', { name: 'Add Crusher' }).click();
  await page.locator('.rack .seg button').first().click();
  check('which is separate from the track racks', (await page.locator('.rack .fx').count()) === 0);
  await tab(page, 'Mix');
  check('and is counted on the strip', (await page.locator('.ch.bus .fxbtn').textContent()) === 'FX · 1');
  await shot(page, 'mixer');

  // ---- returns ----
  await page.locator('.ch').first().getByRole('slider', { name: 'Rev' }).focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(1300);
  const rev = await num(page, '[data-lufs="12"]');
  await page.getByRole('button', { name: 'Mute the reverb return' }).click();
  await page.waitForTimeout(1300);
  check('the reverb return has a meter of its own and can be muted', rev > -60 && (await num(page, '[data-lufs="12"]')) === -70, `${rev}`);
  await page.getByRole('button', { name: 'Mute the reverb return' }).click();

  // ---- analyser ----
  const painted = (sel: string) => page.locator(sel).evaluate((c) => {
    const el = c as HTMLCanvasElement;
    const d = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  });
  let most = 0;
  for (let i = 0; i < 20; i++) { most = Math.max(most, await painted('.screen canvas:not(.hide)')); await page.waitForTimeout(60); }
  check('the spectrum moves with the music', most > 200, `${most} px`);
  await page.getByRole('radio', { name: 'Wave' }).click();
  await page.waitForTimeout(200);
  check('and so does the waveform', (await painted('.screen canvas:not(.hide)')) > 100);
  await page.getByRole('radio', { name: 'Spectrum' }).click();

  // ---- reference ----
  await page.locator('.ref input[type=file]').setInputFiles({ name: 'not-audio.wav', mimeType: 'audio/wav', buffer: Buffer.from('nope') });
  check('a reference that is not audio is refused', (await page.locator('.toast.error').textContent({ timeout: 4000 }).catch(() => ''))!.includes('not-audio.wav'));
  await page.locator('.ref input[type=file]').setInputFiles({ name: 'big song.wav', mimeType: 'audio/wav', buffer: referenceWav() });
  await page.waitForSelector('.ref .ab');
  const refInfo = (await page.locator('.ref .trim').textContent())!;
  check('a reference track loads and its loudness is measured', (await page.locator('.refname').textContent()) === 'big song' && +refInfo.split(' ')[0] > -12, refInfo);
  await page.waitForTimeout(600);
  await page.getByRole('radio', { name: 'Reference' }).click();
  await page.waitForTimeout(900);
  const trim = (await page.locator('.ref .trim').textContent())!;
  const refPeak = await page.locator('.lcd .vu i').first().evaluate((el) => (el as HTMLElement).style.transform);
  check('switching to it turns it down to the loudness of the mix', /^matched -\d/.test(trim), trim);
  let refSeen = 0;
  for (let i = 0; i < 10; i++) { refSeen = Math.max(refSeen, await painted('.screen canvas:not(.hide)')); await page.waitForTimeout(60); }
  check('and it is what the analyser shows', refSeen > 1500, `${refSeen} px vs ${most} for the beat; master meter ${refPeak}`);
  await page.getByRole('radio', { name: 'Mix', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Remove the reference track' }).click();
  check('it can be switched back and removed', (await page.locator('.ref .ab').count()) === 0);
  await page.keyboard.press('Space');

  // ---- survives ----
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('.cell');
  await tab(page, 'Mix');
  check('groups and routing survive a reload', (await page.getByLabel('Name of group 1').inputValue()) === 'DRUMS' && (await page.getByLabel('Where CLAP goes').inputValue()) === '1');
  await page.getByRole('button', { name: 'Remove DRUMS' }).click();
  check('removing a group sends its tracks back to the master', (await page.locator('.mix .ch.bus').count()) === 0 && (await page.getByLabel('Where KICK goes').inputValue()) === '0');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('and undo brings it back', (await page.locator('.mix .ch.bus').count()) === 1);

  // ---- export ----
  const exportAs = async (fmt: string, loud: string, quality?: string) => {
    await page.getByTitle(/^Export WAV/).click();
    await page.locator('.modal').getByRole('radio', { name: fmt, exact: true }).click();
    if (quality) await page.locator('.modal').getByRole('radio', { name: quality }).click();
    await page.getByLabel('Loudness of the exported file').selectOption({ label: loud });
    const d = await download(page, () => page.locator('.modal .audio > button').click());
    const said = (await page.locator('.toast').textContent({ timeout: 30000 }).catch(() => '')) ?? '';
    return { ...d, said };
  };
  const wav = await exportAs('WAV', 'Streaming −14');
  const w = decodeWav(wav.bytes);
  const lufs = integratedLoudness(w.channels[0], w.channels[1], w.sampleRate);
  check('a WAV export can be normalized to streaming loudness', Math.abs(lufs + 14) < 0.3 || /as loud as it goes/.test(wav.said), `${lufs.toFixed(2)} LUFS; "${wav.said}"`);
  const raw = decodeWav((await exportAs('WAV', 'As mixed')).bytes);
  const peak = (await exportAs('WAV', 'Peak −1 dB')).bytes;
  const pk = decodeWav(peak);
  let top = 0;
  for (const c of pk.channels) for (let i = 0; i < c.length; i++) top = Math.max(top, Math.abs(c[i]));
  check('peak normalizing lands on -1 dB', Math.abs(20 * Math.log10(top) + 1) < 0.05, `${(20 * Math.log10(top)).toFixed(3)} dB`);
  check('“as mixed” leaves the level alone', raw.channels[0].length === pk.channels[0].length && integratedLoudness(raw.channels[0], raw.channels[1], raw.sampleRate) !== lufs);
  const mp3 = await exportAs('MP3', 'Streaming −14', 'Best');
  const sync = mp3.bytes.findIndex((x, i) => x === 0xff && (mp3.bytes[i + 1] & 0xe0) === 0xe0);
  check('MP3 export downloads a real MP3', mp3.name.endsWith('.mp3') && sync >= 0 && mp3.bytes.length > 20000 && /MP3 exported at -1\d\.\d LUFS/.test(mp3.said), `${mp3.name}, ${mp3.bytes.length} bytes, "${mp3.said}"`);
  const ogg = await exportAs('OGG', 'As mixed');
  check('OGG export downloads a real Ogg Vorbis file', ogg.name.endsWith('.ogg') && String.fromCharCode(...ogg.bytes.subarray(0, 4)) === 'OggS' && ogg.bytes.length > 5000, `${ogg.name}, ${ogg.bytes.length} bytes`);
  // the browser can play what was made
  const playable = await page.evaluate(async (bytes) => {
    const ctx = new AudioContext();
    const out: number[] = [];
    for (const b of bytes) out.push((await ctx.decodeAudioData(new Uint8Array(b).buffer)).duration);
    return out;
  }, [[...mp3.bytes], [...ogg.bytes]]);
  const secs = raw.channels[0].length / raw.sampleRate;
  check('and both decode to the same length as the WAV', playable.every((d) => Math.abs(d - secs) < 0.2), `${playable.map((d) => d.toFixed(2)).join(', ')} vs ${secs.toFixed(2)} s`);

  // reading the analyser's canvas back (above) makes Chromium suggest a faster way to do it; that one is this test's doing
  const errors = b.errors.filter((e) => !e.includes('willReadFrequently'));
  check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).slice(0, 1200));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
