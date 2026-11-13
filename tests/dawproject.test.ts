import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dawproject, type DawStem } from '../src/core/dawproject';
import { DEMOS } from '../src/core/demos';
import { TEMPLATES } from '../src/core/templates';
import { sanitize, type Project } from '../src/core/types';

const stemsFor = (p: Project): DawStem[] => p.tracks.map((t, i) => ({ track: i, path: `audio/${String(i + 1).padStart(2, '0')}-${t.name.toLowerCase()}.wav`, seconds: 8.25, sampleRate: 48000 }));
let xmllint = true;
try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); } catch { xmllint = false; }
const dir = mkdtempSync(join(tmpdir(), 'dawproject-'));

/** Check a document against the format's own schema. */
function valid(xml: string, schema: string): string {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml);
  try {
    execFileSync('xmllint', ['--noout', '--schema', `tests/fixtures/${schema}`, file], { stdio: 'pipe' });
    return '';
  } catch (e) {
    return String((e as { stderr?: Buffer }).stderr ?? e);
  }
}
const count = (xml: string, tag: string) => (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;

describe('DAWproject export', () => {
  const p = sanitize(TEMPLATES[1].make()); // house
  const out = dawproject(p, [0], stemsFor(p), '9.9.9');

  it.runIf(xmllint)('is valid against the DAWproject schema, for every template and demo, as a pattern and as a song', () => {
    for (const make of [...TEMPLATES.map((t) => t.make), ...DEMOS.map((d) => d.make)]) {
      const q = sanitize(make());
      q.arr.markers.push({ at: 16, name: 'Drop & "more" <loud>', color: 2 });
      q.arr.tempo.push({ at: 32, bpm: 150 });
      q.arr.sigs.push({ at: 0, num: 3, den: 4 });
      for (const chain of [[0, 1], undefined]) {
        const x = dawproject(q, chain, stemsFor(q), '2.1.0');
        expect(valid(x.project, 'dawproject-Project.xsd'), q.name).toBe('');
        expect(valid(x.metadata, 'dawproject-MetaData.xsd'), q.name).toBe('');
      }
    }
  });

  it('has the tempo, an audio track for each stem and a notes track for each part', () => {
    expect(out.project).toContain('<Application name="Loopwell" version="9.9.9"/>');
    expect(out.project).toContain(`unit="bpm" value="${p.bpm}"`);
    expect(count(out.project, 'Audio')).toBe(p.tracks.length);
    const playing = p.tracks.filter((t, i) => (t.kind === 'drum' || t.kind === 'dsyn' ? p.patterns[0].steps[i].some((v) => v) : p.patterns[0].notes[i].length)).length;
    expect((out.project.match(/contentType="notes"/g) ?? []).length).toBe(playing);
    expect(out.project).toContain('role="master"');
    expect(out.project).toContain('<File path="audio/01-kick.wav"/>');
  });

  it('writes every note where it is, in beats', () => {
    const lead = p.tracks.findIndex((t) => t.name === 'LEAD');
    const notes = p.patterns[0].notes[lead];
    for (const n of notes) expect(out.project).toContain(`<Note time="${n.s / 4}" duration="${Math.min(n.l, p.steps - n.s) / 4}" channel="0" key="${n.p}"`);
    // four on the floor: kicks on beats 0..3, on the General MIDI kick
    for (const b of [0, 1, 2, 3]) expect(out.project).toContain(`<Note time="${b}" duration="0.125" channel="0" key="36"`);
    expect(count(out.project, 'Note')).toBe(p.patterns[0].steps.reduce((s, row) => s + row.slice(0, p.steps).filter((v) => v).length, 0) + p.patterns[0].notes.reduce((s, l) => s + l.filter((n) => n.s < p.steps).length, 0));
  });

  it('gives every id once and points only at ids that exist', () => {
    const ids = [...out.project.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of out.project.matchAll(/ (?:destination|track|parameter)="([^"]+)"/g)) expect(ids).toContain(m[1]);
  });

  it('keeps the audio as the sound and the notes muted beside it', () => {
    const noteTracks = out.project.split('<Track ').filter((t) => t.startsWith('contentType="notes"'));
    expect(noteTracks.length).toBeGreaterThan(0);
    for (const t of noteTracks) expect(t).toContain('<Mute value="true"');
    const audioTracks = out.project.split('<Track ').filter((t) => t.startsWith('contentType="audio" '));
    for (const t of audioTracks) { expect(t).toContain('<Mute value="false"'); expect(t).toContain('value="1"'); }
  });

  it('lays the song out clip by clip, with its markers and tempo changes', () => {
    const q = sanitize(TEMPLATES[1].make());
    q.songMode = true;
    q.arr.clips = [
      { id: 'a', track: 0, pattern: 0, start: 0, len: 32, offset: 0 },
      { id: 'b', track: 0, pattern: 1, start: 32, len: 16, offset: 0 },
      { id: 'c', track: 7, pattern: 0, start: 16, len: 12, offset: 4 },
    ];
    q.arr.markers = [{ at: 32, name: 'Drop', color: 1 }];
    q.arr.tempo = [{ at: 32, bpm: 140 }];
    const x = dawproject(q, undefined, [], '1').project;
    expect(x).toContain('<Clip time="0" duration="8" playStart="0" name="KICK A">');
    expect(x).toContain('<Clip time="8" duration="4" playStart="0" name="KICK B">');
    expect(x).toContain('<Clip time="4" duration="3" playStart="0" name="LEAD A">');
    // a pattern loops inside a clip longer than it: eight kicks in two bars
    expect(x.split('name="KICK A">')[1].split('</Clip>')[0].match(/<Note /g)!.length).toBe(8);
    // a clip that starts part-way into its pattern plays from there
    const lead = q.patterns[0].notes[7].filter((n) => n.s >= 4).length;
    expect(x.split('name="LEAD A">')[1].split('</Clip>')[0].match(/<Note /g)!.length).toBe(lead);
    expect(x).toContain('<Marker time="8" name="Drop"');
    expect(x).toContain('<RealPoint time="8" value="140" interpolation="hold"/>');
    expect(count(x, 'Audio')).toBe(0);
  });

  it('measures audio in beats at the tempo it plays at', () => {
    const q = sanitize(TEMPLATES[1].make()); // 124 bpm
    const x = dawproject(q, [0], [{ track: 0, path: 'audio/k.wav', seconds: 60, sampleRate: 44100 }], '1').project;
    expect(x).toContain('<Clip time="0" duration="124" contentTimeUnit="seconds"');
    expect(x).toContain('duration="60" sampleRate="44100"');
  });

  it('survives names with anything in them', () => {
    const q = sanitize(TEMPLATES[0].make());
    q.name = 'Tom & Jerry\'s <"beat">\u0007';
    q.tracks[0].name = 'K<&>"';
    const x = dawproject(q, [0], stemsFor(q), '1');
    expect(x.metadata).toContain('<Title>Tom &amp; Jerry&apos;s &lt;&quot;beat&quot;&gt;</Title>');
    expect(x.project).toContain('name="K&lt;&amp;&gt;&quot;"');
    if (xmllint) { expect(valid(x.project, 'dawproject-Project.xsd')).toBe(''); expect(valid(x.metadata, 'dawproject-MetaData.xsd')).toBe(''); }
  });
});
