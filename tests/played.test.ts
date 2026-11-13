import { describe, expect, it } from 'vitest';
import { makeMod } from '../src/core/creative';
import { dawproject } from '../src/core/dawproject';
import { exportMidi, importMidi } from '../src/core/midi';
import { playedNotes } from '../src/core/played';
import { TEMPLATES } from '../src/core/templates';
import { emptyProject, newPattern, newTrack, sanitize, type Project } from '../src/core/types';

function simple(): Project {
  const p = emptyProject();
  p.bpm = 120;
  p.tracks = [newTrack('drum', 0, 'KICK', 'boom/kick'), newTrack('synth', 1, 'LEAD')];
  p.patterns = p.patterns.map(() => newPattern(2));
  p.patterns[0].steps[0][0] = 100;
  p.patterns[0].steps[0][8] = 120;
  p.patterns[0].notes[1] = [{ s: 4, l: 2, p: 60, v: 90 }];
  return sanitize(p);
}
const of = (list: Awaited<ReturnType<typeof playedNotes>>, track: number) => list.filter((n) => n.track === track);
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

describe('what a beat really plays', () => {
  it('is the grid, for a plain beat', async () => {
    const got = await playedNotes(simple(), [0]);
    expect(of(got, 0).map((n) => [Math.round(n.step * 100) / 100, n.vel])).toEqual([[0, 100], [8, 120]]);
    const lead = of(got, 1);
    expect(lead.length).toBe(1);
    expect(near(lead[0].step, 4) && lead[0].pitch === 60 && lead[0].len > 1.5 && lead[0].len <= 2).toBe(true);
    expect(near(lead[0].time, 0.5)).toBe(true); // step 4 at 120 bpm
  });

  it('has every hit of a roll', async () => {
    const p = simple();
    p.patterns[0].mods[0][8] = makeMod(3, 0, 0);
    const kicks = of(await playedNotes(p, [0]), 0).map((n) => n.step);
    expect(kicks.length).toBe(4);
    expect(near(kicks[1], 8) && near(kicks[2], 8 + 1 / 3) && near(kicks[3], 8 + 2 / 3)).toBe(true);
  });

  it('has swing in it', async () => {
    const p = simple();
    p.patterns[0].steps[0][1] = 100;
    p.swing = 60;
    const kicks = of(await playedNotes(p, [0]), 0).map((n) => n.step);
    expect(kicks[1]).toBeGreaterThan(1.1);
    expect(kicks[1]).toBeLessThan(1.6);
  });

  it('leaves out steps whose turn it isn\'t, and has the ones live code plays', async () => {
    const p = simple();
    p.patterns[0].mods[0][8] = makeMod(1, 0, 2); // a condition: not on every repeat
    const twice = of(await playedNotes(p, [0, 0]), 0);
    expect(twice.length).toBeLessThan(4);
    p.code = 'lead: c5 e5 g5';
    const lead = of(await playedNotes(p, [0]), 1).filter((n) => n.pitch >= 72);
    expect(lead.map((n) => n.pitch)).toEqual([72, 76, 79]);
    expect(near(lead[1].step, 16 / 3)).toBe(true);
  });

  it('plays an arpeggio as the notes it becomes', async () => {
    const p = simple();
    p.patterns[0].notes[1] = [{ s: 0, l: 8, p: 60, v: 100 }, { s: 0, l: 8, p: 64, v: 100 }, { s: 0, l: 8, p: 67, v: 100 }];
    const plain = of(await playedNotes(p, [0]), 1).length;
    p.tracks[1].arpMode = 1;
    const arp = of(await playedNotes(p, [0]), 1);
    expect(plain).toBe(3);
    expect(arp.length).toBeGreaterThan(3);
    expect(new Set(arp.map((n) => n.step)).size).toBeGreaterThan(3);
  });

  it('follows tempo changes in the song', async () => {
    const p = simple();
    p.songMode = true;
    p.arr.clips = [{ id: 'a', track: 0, pattern: 0, start: 0, len: 32, offset: 0 }];
    p.arr.tempo = [{ at: 16, bpm: 60 }];
    const kicks = of(await playedNotes(sanitize(p)), 0);
    expect(kicks.map((n) => Math.round(n.step))).toEqual([0, 8, 16, 24]);
    // the second bar is at half the tempo: a step takes twice as long
    expect(near(kicks[2].time, 2) && near(kicks[3].time, 4)).toBe(true);
  });
});

describe('exports made from what was played', () => {
  it('puts rolls and live code in the MIDI file', async () => {
    const p = simple();
    p.patterns[0].mods[0][8] = makeMod(4, 0, 0);
    p.code = 'lead: c5*3';
    const plain = importMidi(exportMidi(p, [0]));
    const full = importMidi(exportMidi(p, [0], await playedNotes(p, [0])));
    const count = (s: typeof plain) => s.parts.reduce((n, x) => n + x.notes.length, 0);
    expect(count(plain)).toBe(3);
    expect(count(full)).toBe(2 + 3 + 1 + 3); // one kick, a roll of four, the lead's note, three from the code
    expect(Math.round(full.bpm)).toBe(120);
  });

  it('gives the same file as before for a beat with nothing fancy in it', async () => {
    const p = simple();
    const a = importMidi(exportMidi(p, [0])), b = importMidi(exportMidi(p, [0], await playedNotes(p, [0])));
    const flat = (s: typeof a) => s.parts.map((x) => x.notes.map((n) => [Math.round(n.at * 8) / 8, n.pitch, n.vel]));
    expect(flat(b)).toEqual(flat(a));
  });

  it('puts them in the DAW project too, without overlapping clips', async () => {
    const p = sanitize(TEMPLATES[0].make()); // trap: has rolls
    p.code = 'snare: ~ x ~ [x x]';
    const played = await playedNotes(p, [0]);
    const plain = dawproject(p, [0], [], '1').project, full = dawproject(p, [0], [], '1', played).project;
    const notes = (x: string) => (x.match(/<Note /g) ?? []).length;
    expect(notes(full)).toBeGreaterThan(notes(plain));
    expect(notes(full)).toBe(played.length);
    expect(full).toContain('name="SNARE notes"');
    // on each track, no clip starts before the one before it has ended
    for (const lane of full.split('<Lanes track=').slice(1)) {
      let end = 0;
      for (const m of lane.matchAll(/<Clip time="([\d.]+)" duration="([\d.]+)"/g)) { expect(+m[1]).toBeGreaterThanOrEqual(end - 1e-6); end = +m[1] + +m[2]; }
    }
  });
});
