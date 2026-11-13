// End-to-end check of the exports meant for other programs: the DAW project
// and the MIDI-and-stems zip, made in the browser and opened here.
// Run with: npm run test:interop

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { Download, Page } from 'playwright-core';
import { launch } from '../../scripts/_browser';
import { importMidi } from '../../src/core/midi';
import { decodeWav } from '../../src/core/wav';

let failed = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const dir = mkdtempSync(join(tmpdir(), 'interop-'));
let xmllint = true;
try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); } catch { xmllint = false; }
function valid(xml: string, schema: string): string {
  if (!xmllint) return '';
  const file = join(dir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml);
  try { execFileSync('xmllint', ['--noout', '--schema', `tests/fixtures/${schema}`, file], { stdio: 'pipe' }); return ''; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300); }
}
async function save(page: Page, button: string): Promise<{ name: string; files: Record<string, Uint8Array> }> {
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }) as Promise<Download>, page.locator('.modal .list button', { hasText: button }).first().click()]);
  return { name: d.suggestedFilename(), files: unzipSync(new Uint8Array(readFileSync((await d.path())!))) };
}
const peak = (wav: Uint8Array) => { const w = decodeWav(wav); let p = 0; for (const x of w.channels[0]) p = Math.max(p, Math.abs(x)); return { peak: p, seconds: w.channels[0].length / w.sampleRate, rate: w.sampleRate }; };

const b = await launch();
const { page, url, errors } = b;
try {
  await page.goto(url);
  await page.waitForSelector('.cell');
  await page.getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.locator('.modal .list button', { hasText: 'House' }).click();
  await page.waitForSelector('.cell.ph');
  await page.keyboard.press('Space');

  // --- MIDI and stems, one zip ---
  const zip = await save(page, 'MIDI and stems');
  const names = Object.keys(zip.files).sort();
  check(`one zip (${zip.name}) holds the MIDI file, the stems and a note`, zip.name === 'house-starter-midi-and-stems.zip' && names.includes('house-starter.mid') && names.includes('readme.txt')
    && names.filter((n) => /^stems\/\d\d-[a-z0-9-]+\.wav$/.test(n)).length === 7, names.join(', '));
  const song = importMidi(zip.files['house-starter.mid']);
  check('the MIDI file reads back with the tempo and a part for each track', Math.round(song.bpm) === 124 && song.parts.length === 7, `${song.bpm} bpm, ${song.parts.length} parts`);
  const kick = peak(zip.files['stems/01-kick.wav']);
  check('the stems are real audio, at the device\'s rate', kick.peak > 0.1 && kick.seconds > 1.5 && kick.rate >= 44100, `kick peaks at ${kick.peak.toFixed(2)}, ${kick.seconds.toFixed(1)} s`);
  const note = strFromU8(zip.files['readme.txt']);
  check('the note says the tempo and the key', /Tempo: 124 BPM/.test(note) && /Key: C minor/.test(note) && note.split('\n').length > 6, note.split('\n').slice(0, 4).join(' | '));
  await page.waitForFunction(() => /MIDI and 7 stems exported/.test(document.querySelector('.toast')?.textContent ?? ''));

  // --- the DAW project ---
  const daw = await save(page, 'DAW project');
  const files = Object.keys(daw.files).sort();
  check(`a .dawproject (${daw.name}) holds project.xml, metadata.xml and the audio`, daw.name === 'house-starter.dawproject' && files.includes('project.xml') && files.includes('metadata.xml')
    && files.filter((n) => n.startsWith('audio/')).length === 7, files.join(', '));
  const xml = strFromU8(daw.files['project.xml']);
  const bad = valid(xml, 'dawproject-Project.xsd') + valid(strFromU8(daw.files['metadata.xml']), 'dawproject-MetaData.xsd');
  check(`both are valid against the format's schema${xmllint ? '' : ' (xmllint not here: skipped)'}`, bad === '', bad);
  const refs = [...xml.matchAll(/<File path="([^"]+)"/g)].map((m) => m[1]);
  check('every audio file it points at is in the zip', refs.length === 7 && refs.every((r) => r in daw.files), refs.join(', '));
  check('it carries the tempo, the tracks and their notes', xml.includes('unit="bpm" value="124"') && (xml.match(/contentType="notes"/g) ?? []).length === 7 && (xml.match(/<Note /g) ?? []).length > 30
    && /<Application name="Loopwell" version="\d+\.\d+\.\d+"\/>/.test(xml));
  const secs = +(/<Audio algorithm="raw" channels="2" duration="([\d.]+)"/.exec(xml)?.[1] ?? 0);
  const real = peak(daw.files[refs[0]]);
  check('audio lengths in the project match the files', Math.abs(secs - real.seconds) < 0.01, `${secs} s against ${real.seconds.toFixed(3)} s`);

  // --- the song, with code playing on a track the grid leaves empty ---
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Live code').fill('snare: ~ x ~ x');
  await page.getByLabel('Live code').blur();
  const coded = await save(page, 'Stems');
  check('a track only the code plays gets a stem too', Object.keys(coded.files).some((n) => /02-snare\.wav$/.test(n)) && peak(coded.files['02-snare.wav']).peak > 0.05, Object.keys(coded.files).join(', '));

  // --- nothing to export ---
  await page.getByLabel('Live code').fill('');
  await page.getByLabel('Live code').blur();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('clear the whole pattern');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.locator('.modal .list button', { hasText: 'DAW project' }).first().click();
  await page.waitForFunction(() => /Nothing to export yet/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 20000 });
  check('an empty pattern is refused with a reason', true);

  // --- from the palette ---
  if (await page.locator('.modal').count()) await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('bitwig');
  await page.waitForTimeout(200);
  check('the palette finds it by the name of a DAW', /DAW project/.test((await page.locator('.palette').textContent()) ?? ''));
  await page.keyboard.press('Escape');

  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, e instanceof Error ? e.message : String(e));
} finally {
  await b.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
