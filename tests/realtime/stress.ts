import { INSERT_TYPES } from '../../src/core/dsp/inserts';
import { emptyProject, newId, newInsert, synth } from '../../src/core/types';

/**
 * A song built to hurt: every step on, on every track, six-note chords on both
 * synths (five-voice unison, two wavetable oscillators, noise, LFO and mod
 * envelope), a sliced and time-stretched sample, all five insert effects on
 * every track, sends and master effects up, automation and tempo changes.
 */
export function stressProject() {
  const p = emptyProject();
  p.bpm = 200;
  p.steps = 32;
  p.swing = 55;
  p.fx.filter = -20;
  p.tracks.forEach((t, i) => {
    t.rev = 100; t.dly = 100; t.filter = i % 2 ? 30 : -30; t.pan = i * 16 - 60;
    t.fx = INSERT_TYPES.map((type) => newInsert(type));
    t.fx[4].p[0] = 1; // everything ducks to the kick
    t.fx[0].p = [80, 50, 76, 64];
  });
  p.tracks[5].kind = 'slice';
  p.tracks[5].sample = 'boom/crash';
  p.tracks[5].slices = [0, 8000, 20000, 40000];
  p.tracks[5].stretch = 96;
  p.tracks[6].synth = synth({
    wave: 6, pos: 30, wave2: 8, pos2: 60, semi2: 7, mix: 64, noise: 30, uni: 5, detune: 60, spread: 127,
    sustain: 100, release: 90, lfoAmt: 40, lfoRate: 90, lfoDest: 2, menvAmt: 50, menvDecay: 80, menvDest: 0,
  });
  p.tracks[7].synth = synth({
    wave: 0, wave2: 1, semi2: 12, mix: 50, uni: 5, detune: 40, spread: 100,
    sustain: 100, release: 90, lfoAmt: -30, lfoSync: true, lfoRate: 80, lfoDest: 1, menvAmt: 40, menvDest: 3,
  });
  for (const pat of p.patterns) {
    p.tracks.forEach((t, i) => {
      for (let s = 0; s < 32; s++) {
        if (t.kind === 'drum') pat.steps[i][s] = 60 + ((s * 7) % 60);
        else if (t.kind === 'slice') pat.notes[i].push({ s, l: 2, p: s % 4, v: 100 });
        else for (const off of [0, 4, 7, 11, 14, 19]) pat.notes[i].push({ s, l: 4, p: 40 + off + (s % 5), v: 100 });
      }
    });
  }
  // sixteen bars of clips, each track cycling through the patterns, played as a song
  const a = p.arr;
  a.clips = [];
  for (let bar = 0; bar < 16; bar++) {
    for (let t = 0; t < p.tracks.length; t++) a.clips.push({ id: newId(), track: t, pattern: (bar + t) % 8, start: bar * 32, len: 32, offset: 0 });
  }
  a.tempo = [{ at: 128, bpm: 170 }, { at: 256, bpm: 220 }];
  const sweep = (len: number) => Array.from({ length: 64 }, (_, i) => ({ t: i * len, v: (i * 37) % 128 }));
  a.lanes = [
    ...p.tracks.map((_, t) => ({ id: newId(), track: t, param: 'vol', on: true, points: sweep(8).map((pt) => ({ t: pt.t, v: 70 + (pt.v % 50) })) })),
    { id: newId(), track: 6, param: 'cutoff', on: true, points: sweep(6) },
    { id: newId(), track: 6, param: 'pos', on: true, points: sweep(5) },
    { id: newId(), track: 7, param: 'detune', on: true, points: sweep(7) },
    { id: newId(), track: -1, param: 'mfilter', on: true, points: sweep(9).map((pt) => ({ t: pt.t, v: (pt.v % 60) - 30 })) },
  ];
  p.songMode = true;
  return p;
}
