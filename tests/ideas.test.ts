import { describe, expect, it } from 'vitest';
import { fitLoop, hearNotes, notesFromHeard, tapsToSteps } from '../src/core/ideas';
import { exportMidi, importMidi, midiToProject } from '../src/core/midi';
import { DEMOS } from '../src/core/demos';
import { inScale } from '../src/core/scales';
import { emptyProject } from '../src/core/types';

const SR = 44100;
const hz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** A sung-ish line: each note a tone with a few harmonics and a little vibrato, with short gaps between. */
function sing(notes: [pitch: number, seconds: number][], gap = 0.06, sr = SR): Float32Array {
  const total = notes.reduce((a, [, s]) => a + s + gap, 0.2);
  const out = new Float32Array(Math.round(total * sr));
  let at = Math.round(0.1 * sr), ph = 0;
  for (const [p, secs] of notes) {
    const n = Math.round(secs * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = hz(p) * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t));
      ph += (2 * Math.PI * f) / sr;
      const env = Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
      out[at + i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * 0.25 * env;
    }
    at += n + Math.round(gap * sr);
  }
  return out;
}

describe('hearing a melody', () => {
  it('finds each note, its pitch and when it starts', () => {
    const line: [number, number][] = [[60, 0.25], [62, 0.25], [64, 0.5], [67, 0.25], [60, 0.5]];
    const heard = hearNotes(sing(line), SR);
    expect(heard.length).toBe(5);
    heard.forEach((h, i) => expect(Math.abs(h.pitch - line[i][0]), `note ${i}`).toBeLessThan(0.3));
    let t = 0.1;
    heard.forEach((h, i) => {
      expect(Math.abs(h.start - t), `start of note ${i}`).toBeLessThan(0.05);
      expect(Math.abs(h.length - line[i][1])).toBeLessThan(0.09); // the analysis window is 64 ms wide
      t += line[i][1] + 0.06;
    });
  });

  it('hears low and high voices, at any sample rate', () => {
    for (const sr of [44100, 48000, 22050]) {
      for (const base of [43, 57, 76]) { // a low G, an A, a high E
        const heard = hearNotes(sing([[base, 0.3], [base + 4, 0.3], [base + 7, 0.3]], 0.06, sr), sr);
        expect(heard.map((h) => Math.round(h.pitch)), `${base} at ${sr}`).toEqual([base, base + 4, base + 7]);
      }
    }
  });

  it('follows a change of note with no gap between', () => {
    const heard = hearNotes(sing([[60, 0.3], [65, 0.3], [62, 0.3]], 0), SR);
    expect(heard.map((h) => Math.round(h.pitch))).toEqual([60, 65, 62]);
  });

  it('hears nothing in silence, noise or a click', () => {
    expect(hearNotes(new Float32Array(SR), SR)).toEqual([]);
    let s = 3;
    const noise = Float32Array.from({ length: SR }, () => { s = (s * 1103515245 + 12345) | 0; return (s / 2147483648) * 0.3; });
    expect(hearNotes(noise, SR)).toEqual([]);
    const click = new Float32Array(SR); click[1000] = 1;
    expect(hearNotes(click, SR)).toEqual([]);
    expect(hearNotes(new Float32Array(10), SR)).toEqual([]);
  });

  it('puts what it heard on the grid: in time, in key, in the track\'s octave', () => {
    // at 120 bpm a step is 0.125 s: notes a quarter, a quarter and a half beat apart... sung an octave below the synth
    const heard = hearNotes(sing([[48, 0.19], [50, 0.19], [51, 0.44], [55, 0.19]], 0.06), SR);
    const notes = notesFromHeard(heard, { bpm: 120, steps: 16, scale: { root: 0, type: 1 }, around: 62 });
    expect(notes.map((n) => n.s)).toEqual([0, 2, 4, 8]);
    expect(notes.map((n) => n.p)).toEqual([60, 62, 63, 67]);
    expect(notes.map((n) => n.l)).toEqual([2, 2, 4, 2]);
    expect(notes.every((n) => inScale(n.p, 0, 1) && n.v >= 40 && n.v <= 127)).toBe(true);
  });

  it('snaps a note that is out of key, unless asked not to', () => {
    const heard = [{ start: 0, length: 0.25, pitch: 61.1, level: 1 }];
    expect(notesFromHeard(heard, { bpm: 120, steps: 16, scale: { root: 0, type: 0 }, around: 60 })[0].p).toBe(60);
    expect(notesFromHeard(heard, { bpm: 120, steps: 16, scale: null, around: 60 })[0].p).toBe(61);
  });

  it('keeps a line to one note at a time and inside the pattern', () => {
    const heard = [
      { start: 1, length: 1, pitch: 60, level: 1 }, { start: 1.05, length: 0.2, pitch: 62, level: 1 }, { start: 1.5, length: 0.25, pitch: 64, level: 0.5 },
      { start: 2.9, length: 5, pitch: 65, level: 1 }, { start: 9, length: 1, pitch: 67, level: 1 },
    ];
    const notes = notesFromHeard(heard, { bpm: 120, steps: 16, scale: null, around: 60 });
    expect(notes.map((n) => [n.s, n.l])).toEqual([[0, 4], [4, 2], [15, 1]]);
    expect(notesFromHeard([], { bpm: 120, steps: 16, scale: null, around: 60 })).toEqual([]);
  });
});

describe('tapping a rhythm', () => {
  const on = (t: { steps: number[] }) => t.steps.flatMap((v, i) => (v ? [i] : []));
  const taps = (steps: number[], bpm: number, wobble = 0) => steps.map((s, i) => 2.5 + s * (15 / bpm) + (i % 2 ? wobble : -wobble));

  it('puts taps on the nearest step at the song\'s tempo', () => {
    const t = tapsToSteps(taps([0, 3, 6, 8, 11, 14], 120, 0.02), [], 16, 120)!;
    expect(on(t)).toEqual([0, 3, 6, 8, 11, 14]);
    expect(t.bpm).toBe(120);
    expect(t.error).toBeLessThan(0.35);
  });

  it('works out the tempo from the taps when it isn\'t given one', () => {
    for (const bpm of [80, 95, 120, 140]) {
      const t = tapsToSteps(taps([0, 4, 6, 8, 12, 14, 16, 20, 22, 24, 28], bpm, 0.006), [], 32)!;
      // twice or half the tempo is the same rhythm written another way
      const ratio = t.bpm / bpm;
      expect([0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.03), `${bpm} heard as ${t.bpm}`).toBe(true);
      expect(on(t).length).toBe(11);
    }
  });

  it('reads an even pulse as beats, even when the taps wobble', () => {
    // a tap every 600 ms is 100 bpm, not dotted 8ths at 75
    for (const wobble of [0, 0.012, 0.02]) {
      const t = tapsToSteps(Array.from({ length: 8 }, (_, i) => 1 + i * 0.6 + (i % 3 === 1 ? wobble : i % 3 === 2 ? -wobble : 0)), [], 16)!;
      expect(Math.abs(t.bpm - 100), `wobble ${wobble}: ${t.bpm}`).toBeLessThan(3);
      expect(on(t)).toEqual([0, 4, 8, 12]);
    }
  });

  it('keeps how hard each tap was, and wraps a long rhythm round the pattern', () => {
    const t = tapsToSteps(taps([0, 4, 16, 20], 120), [127, 60, 90, 100], 16, 120)!;
    expect(on(t)).toEqual([0, 4]);
    expect([t.steps[0], t.steps[4]]).toEqual([127, 100]);
  });

  it('needs something to go on', () => {
    expect(tapsToSteps([], [], 16)).toBeNull();
    expect(tapsToSteps([1], [], 16)).toBeNull();
    expect(on(tapsToSteps([1], [], 16, 120)!)).toEqual([0]);
  });
});

describe('fitting a loop', () => {
  it('works out the bars, slices on the 8ths and writes the notes that play it back', () => {
    const fit = fitLoop(4, 120, 32)!; // four seconds at 120 is two bars
    expect(fit.beats).toBe(8);
    expect(fit.bpm).toBe(120);
    expect(fit.slices.length).toBe(16);
    expect(fit.slices[0]).toBe(0);
    expect(fit.slices[8]).toBe(32768);
    expect(fit.notes.map((n) => [n.s, n.p, n.l])).toEqual(Array.from({ length: 16 }, (_, i) => [i * 2, i, 2]));
  });

  it('trusts the length over a tempo that is a little off, and only writes what fits the pattern', () => {
    const fit = fitLoop(1.92, 122, 16)!; // exactly one bar at 125
    expect(fit.beats).toBe(4);
    expect(fit.bpm).toBe(125);
    const long = fitLoop(8, 120, 16)!;
    expect(long.steps).toBe(64);
    expect(long.notes.length).toBe(8);
    expect(long.notes[7].s).toBe(14);
  });

  it('says no to things that aren\'t loops', () => {
    expect(fitLoop(0.2, 120, 16)).toBeNull();
    expect(fitLoop(4, 0, 16)).toBeNull();
  });
});

describe('MIDI import', () => {
  it('reads back what Loopwell exports', () => {
    for (const d of DEMOS) {
      const p = d.make();
      const song = importMidi(exportMidi({ ...p, swing: 0 }));
      expect(song.bpm).toBe(p.bpm);
      const drumHits = song.parts.filter((x) => x.drums).reduce((a, x) => a + x.notes.length, 0);
      const noteCount = song.parts.filter((x) => !x.drums).reduce((a, x) => a + x.notes.length, 0);
      expect(drumHits, d.name).toBeGreaterThan(0);
      expect(noteCount, d.name).toBeGreaterThan(0);
      expect(song.parts.every((x) => x.notes.every((n) => Math.abs(n.at - Math.round(n.at)) < 0.01))).toBe(true);
    }
  });

  it('lays a file out as tracks, patterns and a timeline that play the same notes', () => {
    const p = emptyProject();
    p.bpm = 97;
    p.patterns[0].steps[0][0] = 100; p.patterns[0].steps[0][8] = 100;
    p.patterns[0].steps[3][2] = 80;
    p.patterns[0].notes[6] = [{ s: 0, l: 4, p: 36, v: 90 }, { s: 8, l: 2, p: 43, v: 90 }];
    p.patterns[1].steps[0][4] = 100;
    p.patterns[1].notes[7] = [{ s: 3, l: 1, p: 72, v: 70 }];
    const { project: q, bars, totalBars, skipped } = midiToProject(importMidi(exportMidi(p, [0, 1, 0, 0])));
    expect([bars, totalBars, skipped]).toEqual([4, 4, 0]);
    expect(q.bpm).toBe(97);
    expect(q.tracks.map((t) => [t.kind, t.name])).toEqual([['drum', 'KICK'], ['drum', 'HAT'], ['synth', 'BASS'], ['synth', 'LEAD']]);
    expect(q.tracks[0].sample).toBe('boom/kick');
    // three of the four bars are the same, so they share a pattern
    expect(q.arr.clips.filter((c) => c.track === 0).map((c) => [c.pattern, c.start, c.len])).toEqual([[0, 0, 16], [1, 16, 16], [0, 32, 32]]);
    expect(q.patterns[0].steps[0].slice(0, 16).flatMap((v, i) => (v ? [i] : []))).toEqual([0, 8]);
    expect(q.patterns[0].steps[1][2]).toBe(80);
    expect(q.patterns[0].notes[2].map((n) => [n.s, n.l, n.p])).toEqual([[0, 4, 36], [8, 2, 43]]);
    expect(q.patterns[1].notes[3].map((n) => [n.s, n.p])).toEqual([[3, 72]]);
    expect(q.songMode).toBe(true);
  });

  it('reads running status, format 0 and note-ons with velocity 0', () => {
    const file = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, // MThd, format 0, 96 ticks a beat
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 27,
      0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, // 120 bpm
      0, 0x90, 60, 100, // note on
      24, 60, 0, // running status: note on with velocity 0 = off, a 16th later
      0, 64, 90,
      48, 64, 0,
      0, 0xff, 0x2f, 0,
    ]);
    const song = importMidi(file);
    expect(song.bpm).toBe(120);
    expect(song.parts[0].notes.map((n) => [n.at, n.len, n.pitch, n.vel])).toEqual([[0, 1, 60, 100], [1, 2, 64, 90]]);
  });

  it('refuses things that are not MIDI, and files with nothing in them', () => {
    expect(() => importMidi(new Uint8Array([1, 2, 3]))).toThrow('not a MIDI file');
    expect(() => importMidi(new TextEncoder().encode('MThd but not really, just some text here'))).toThrow();
    expect(() => importMidi(exportMidi(emptyProject()))).toThrow('no notes');
  });

  it('stops at eight tracks and eight different bars, and says what it left out', () => {
    const p = emptyProject();
    for (let i = 0; i < 8; i++) { p.patterns[i].steps[0][i] = 100; p.patterns[i].notes[7] = [{ s: i, l: 1, p: 60 + i, v: 100 }]; }
    const many = midiToProject(importMidi(exportMidi(p, [0, 1, 2, 3, 4, 5, 6, 7, 0, 1])));
    expect(many.bars).toBe(10);
    // a ninth different bar doesn't fit
    p.patterns[7].steps[0][15] = 100;
    const song = importMidi(exportMidi(p, [0, 1, 2, 3, 4, 5, 6, 7]));
    song.parts[0].notes.push({ at: 16 * 8 + 3, len: 1, pitch: 36, vel: 100 });
    song.steps = 16 * 9;
    const cut = midiToProject(song);
    expect([cut.bars, cut.totalBars]).toEqual([8, 9]);
    // more parts than tracks
    const wide = importMidi(exportMidi(p, [0]));
    for (let i = 0; i < 9; i++) wide.parts.push({ name: `P${i}`, drums: false, notes: [{ at: 0, len: 1, pitch: 60, vel: 100 }] });
    const w = midiToProject(wide);
    expect(w.project.tracks.length).toBe(8);
    expect(w.skipped).toBe(3);
  });
});
