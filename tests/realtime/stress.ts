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

/**
 * The same song with everything added since 2.0 piled on top: an 808 and drum synths, four-hit rolls and
 * chance on every drum step, arpeggiated chords, a groove, and every track in a group with its own effects.
 */
export function fullProject() {
  const p = stressProject();
  p.groove = 5; p.grooveAmt = 80;
  p.tracks[6].kind = 'bass';
  p.tracks[6].bass = { glide: 70, drive: 100, decay: 110, tone: 90, punch: 60, follow: true, key: 3 };
  p.tracks[1].kind = 'dsyn'; p.tracks[1].dsyn = { model: 1, tune: 2, decay: 90, tone: 80, snap: 90 };
  p.tracks[3].kind = 'dsyn'; p.tracks[3].dsyn = { model: 2, tune: 0, decay: 70, tone: 64, snap: 40 };
  p.tracks[7].arpMode = 3; p.tracks[7].arpRate = 3; p.tracks[7].arpOct = 3;
  p.buses = [0, 1, 2, 3].map((k) => ({ name: `G${k}`, vol: 90, mute: false, fx: INSERT_TYPES.slice(0, 4).map((type) => newInsert(type)) }));
  p.tracks.forEach((t, i) => { t.bus = (i % 4) + 1; t.groove = i % 2 ? 4 : 0; });
  for (const pat of p.patterns) {
    p.tracks.forEach((t, i) => {
      if (t.kind !== 'drum' && t.kind !== 'dsyn') return;
      for (let s = 0; s < 32; s++) pat.mods[i][s] = 3 | ((s % 3 ? 0 : 2) << 2); // four hits a step, some at 75%
    });
  }
  return p;
}
