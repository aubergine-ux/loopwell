// Starting points by genre: the right tempo, kit, sounds and a first pattern
// or two, so a beginner is one edit away from something that sounds like the
// music they came to make. Unlike the demos they are meant to be changed.

import { makeMod } from './creative';
import { beat } from './demos';
import { defaultBass, defaultDsyn, synth, type Project } from './types';

export interface Template {
  id: string;
  name: string;
  blurb: string;
  /** The built-in kit it uses. */
  kit: string;
  bpm: number;
  make: () => Project;
}

/** Turn track 6 (the bass) into an 808 in the song's key. */
function use808(p: Project, part: Partial<ReturnType<typeof defaultBass>> = {}): void {
  const t = p.tracks[6];
  t.kind = 'bass';
  t.name = '808';
  t.bass = { ...defaultBass(), key: p.scaleRoot, ...part };
}

/** Give a step a roll and, optionally, a chance of playing. */
const roll = (p: Project, pat: number, track: number, step: number, hits: number, chance = 0) => {
  p.patterns[pat].mods[track][step] = makeMod(hits, chance, 0);
};

const trap = () => beat('Trap starter', 'punch', [
  {
    kick: 'X-----x---x-----', clap: '--------X-------', hat: 'x-x-x-x-x-x-x-x-', open: '--------------x-', perc: '---o------o-----',
    bass: [[0, 29, 6], [6, 29, 2], [10, 29, 5], [14, 32, 3]],
    lead: [[0, 65, 2, 84], [3, 68, 1, 70], [6, 72, 2, 84], [10, 70, 2, 76], [14, 68, 2, 70]],
  },
  {
    kick: 'X-----x--x--x---', clap: '--------X-------', snare: '--------------xx', hat: 'x-x-x-x-x-x-x-x-', open: '------x---------',
    bass: [[0, 29, 6], [6, 27, 3], [9, 29, 3], [12, 24, 4]],
    lead: [[0, 65, 2, 84], [3, 68, 1, 70], [6, 72, 2, 84], [10, 75, 2, 76], [14, 72, 2, 70]],
  },
], (p) => {
  p.bpm = 140; p.scaleRoot = 5; p.scaleType = 1; // F minor
  use808(p, { glide: 62, drive: 58, decay: 104, punch: 46 });
  p.tracks[6].note = 29;
  // the hi-hat rolls that make it trap: a triplet here, a burst there
  roll(p, 0, 3, 6, 3); roll(p, 0, 3, 14, 4); roll(p, 1, 3, 4, 2); roll(p, 1, 3, 10, 3); roll(p, 1, 3, 14, 4);
  roll(p, 0, 5, 3, 1, 4); // a perc that only turns up half the time
  p.tracks[0].vol = 106; p.tracks[3].vol = 58; p.tracks[4].vol = 52; p.tracks[5].vol = 50; p.tracks[5].rev = 50;
  p.tracks[2].rev = 30;
  p.tracks[7].note = 65; p.tracks[7].vol = 60; p.tracks[7].rev = 70; p.tracks[7].dly = 50;
  p.tracks[7].synth = synth({ wave: 3, cutoff: 80, reso: 10, env: 30, attack: 0, decay: 50, sustain: 30, release: 60 });
  p.fx.revSize = 80; p.fx.dlyTime = 3;
});

const house = () => beat('House starter', 'boom', [
  {
    kick: 'X---X---X---X---', clap: '----x-------x---', hat: '--x---x---x---x-', open: '--x---x---x---x-', perc: '---o--o----o--o-',
    bass: [[2, 36, 1], [3, 36, 1], [6, 36, 1], [10, 39, 1], [11, 36, 1], [14, 34, 2]],
    lead: [[0, [60, 63, 67], 3, 78], [6, [60, 63, 67], 2, 70], [8, [58, 62, 65], 3, 78], [14, [58, 62, 65], 2, 70]],
  },
  {
    kick: 'X---X---X---X---', clap: '----x-------x--x', hat: 'x-x-x-x-x-x-x-x-', open: '--x---x---x---x-', perc: '---o--o----o--o-',
    bass: [[2, 36, 1], [3, 36, 1], [6, 36, 1], [10, 41, 1], [11, 39, 1], [14, 34, 2]],
    lead: [[0, [60, 63, 67], 3, 78], [6, [60, 63, 67], 2, 70], [8, [56, 60, 63], 3, 78], [14, [58, 62, 65], 2, 70]],
  },
], (p) => {
  p.bpm = 124; p.scaleRoot = 0; p.scaleType = 1; // C minor
  p.tracks[0].vol = 110; p.tracks[3].vol = 50; p.tracks[4].vol = 60; p.tracks[4].decay = 80; p.tracks[5].vol = 48; p.tracks[5].pan = 20;
  p.tracks[2].rev = 34;
  p.tracks[6].note = 36;
  p.tracks[6].synth = synth({ wave: 1, cutoff: 50, reso: 46, env: 66, attack: 0, decay: 38, sustain: 10, release: 16 });
  // the pumping sidechain: bass and chords duck every time the kick hits
  p.tracks[6].fx = [{ type: 'duck', on: true, p: [1, 90, 60, 0] }];
  p.tracks[7].note = 60; p.tracks[7].vol = 62; p.tracks[7].rev = 56; p.tracks[7].dly = 40;
  p.tracks[7].synth = synth({ wave: 0, cutoff: 64, reso: 20, env: 36, attack: 2, decay: 50, sustain: 44, release: 46, uni: 3, detune: 22, spread: 90 });
  p.tracks[7].fx = [{ type: 'duck', on: true, p: [1, 80, 60, 0] }];
  p.fx.revSize = 76; p.fx.dlyTime = 3; p.fx.dlyFb = 46;
});

const boomBap = () => beat('Boom bap starter', 'dust', [
  {
    kick: 'X------x--x-----', snare: '----X-------X---', hat: 'x-x-x-x-x-x-x-x-', open: '--------------x-', perc: '-------o--------',
    bass: [[0, 33, 3], [7, 33, 2], [10, 36, 3], [14, 31, 2]],
    lead: [[0, [57, 60, 64], 4, 70], [8, [55, 59, 62], 4, 70]],
  },
  {
    kick: 'X------x--x--x--', snare: '----X-------X--o', hat: 'x-x-x-x-x-x-x-x-', open: '------x---------',
    bass: [[0, 33, 3], [7, 33, 2], [10, 29, 3], [14, 31, 2]],
    lead: [[0, [57, 60, 64], 4, 70], [8, [53, 57, 60], 4, 70]],
  },
], (p) => {
  p.bpm = 88; p.scaleRoot = 9; p.scaleType = 1; // A minor
  p.swing = 46; // the lean that makes heads nod
  p.groove = 4; p.grooveAmt = 30; // and hands that aren't quite a machine
  p.tracks[0].vol = 108; p.tracks[1].vol = 104; p.tracks[3].vol = 56; p.tracks[4].vol = 50; p.tracks[5].vol = 54;
  p.tracks[1].fx = [{ type: 'crush', on: true, p: [40, 30, 50, 0] }];
  p.tracks[6].note = 33;
  p.tracks[6].synth = synth({ wave: 3, cutoff: 60, reso: 10, env: 30, attack: 0, decay: 56, sustain: 50, release: 24 });
  p.tracks[7].note = 57; p.tracks[7].vol = 58; p.tracks[7].rev = 44; p.tracks[7].filter = -18;
  p.tracks[7].synth = synth({ wave: 2, cutoff: 56, reso: 14, env: 30, attack: 1, decay: 60, sustain: 40, release: 50 });
  p.fx.revSize = 60;
});

const lofi = () => beat('Lo-fi starter', 'dust', [
  {
    kick: 'x-----x---x-----', snare: '----x-------x---', hat: 'o-x-o-x-o-x-o-x-', perc: '-----------o----',
    bass: [[0, 38, 4], [6, 38, 2], [8, 36, 4], [14, 33, 2]],
    lead: [[0, [62, 65, 69, 72], 7, 62], [8, [60, 64, 67, 71], 7, 62]],
  },
  {
    kick: 'x-----x---x--x--', snare: '----x-------x---', hat: 'o-x-o-x-o-x-o-x-', open: '--------------x-',
    bass: [[0, 31, 4], [6, 31, 2], [8, 33, 4], [14, 36, 2]],
    lead: [[0, [55, 59, 62, 65], 7, 62], [8, [57, 60, 64, 67], 7, 62]],
  },
], (p) => {
  p.bpm = 78; p.scaleRoot = 2; p.scaleType = 2; // D dorian
  p.swing = 36;
  p.groove = 5; p.grooveAmt = 34; // loose, like it was played half asleep
  p.tracks[0].vol = 100; p.tracks[1].vol = 92; p.tracks[1].tune = -3; p.tracks[3].vol = 48; p.tracks[4].vol = 44; p.tracks[5].vol = 46; p.tracks[5].rev = 50;
  p.tracks[6].note = 38; p.tracks[6].vol = 96;
  p.tracks[6].synth = synth({ wave: 3, cutoff: 52, reso: 8, env: 24, attack: 1, decay: 60, sustain: 56, release: 30 });
  p.tracks[7].name = 'KEYS'; p.tracks[7].note = 62; p.tracks[7].vol = 66; p.tracks[7].rev = 50;
  p.tracks[7].synth = synth({ wave: 2, cutoff: 48, reso: 12, env: 34, attack: 1, decay: 66, sustain: 30, release: 56, lfoAmt: 6, lfoDest: 1, lfoRate: 34 });
  // dusty: a crushed, wobbly chorus on the keys and the top rolled off the whole mix
  p.tracks[7].fx = [{ type: 'chorus', on: true, p: [40, 50, 60, 64] }, { type: 'crush', on: true, p: [30, 26, 44, 0] }];
  p.fx.filter = -14; p.fx.revSize = 66;
});

const drill = () => beat('Drill starter', 'glass', [
  {
    kick: 'X-------x-x-----', snare: '------------X---', hat: 'x--x--x-x--x--x-', open: '----------x-----', perc: '--o--------o----',
    bass: [[0, 31, 7], [6, 34, 3], [8, 31, 3], [10, 26, 6]],
    lead: [[0, 67, 3, 80], [3, 70, 3, 72], [6, 74, 2, 80], [8, 72, 3, 76], [11, 70, 3, 70], [14, 69, 2, 70]],
  },
  {
    kick: 'X-----x-x-x-----', snare: '------------X--o', hat: 'x--x--x-x--x--x-', open: '------x---------',
    bass: [[0, 31, 7], [6, 27, 3], [8, 31, 3], [10, 38, 6]],
    lead: [[0, 67, 3, 80], [3, 70, 3, 72], [6, 75, 2, 80], [8, 74, 3, 76], [11, 70, 3, 70], [14, 67, 2, 70]],
  },
], (p) => {
  p.bpm = 142; p.scaleRoot = 7; p.scaleType = 8; // G harmonic minor
  // the sound of drill is the 808 sliding between notes: these overlap on purpose, with a slow glide
  use808(p, { glide: 86, drive: 50, decay: 110, punch: 30 });
  p.tracks[6].note = 31;
  roll(p, 0, 3, 6, 3); roll(p, 0, 3, 14, 2); roll(p, 1, 3, 3, 2); roll(p, 1, 3, 11, 3);
  // a snare made from knobs rather than a sample, tuned up and short
  p.tracks[1].kind = 'dsyn'; p.tracks[1].dsyn = { ...defaultDsyn(1), tune: 4, decay: 36, snap: 90 };
  p.tracks[0].vol = 106; p.tracks[3].vol = 54; p.tracks[4].vol = 50; p.tracks[5].vol = 44; p.tracks[5].rev = 60;
  p.tracks[7].name = 'BELL'; p.tracks[7].note = 67; p.tracks[7].vol = 56; p.tracks[7].rev = 76; p.tracks[7].dly = 44;
  p.tracks[7].synth = synth({ wave: 3, cutoff: 90, reso: 6, env: 20, attack: 0, decay: 40, sustain: 6, release: 60, wave2: 3, semi2: 19, mix: 44 });
  p.fx.revSize = 90; p.fx.dlyTime = 4;
});

export const TEMPLATES: Template[] = [
  { id: 'trap', name: 'Trap', blurb: 'Rolling hats, a sliding 808, half-time clap', kit: 'punch', bpm: 140, make: trap },
  { id: 'house', name: 'House', blurb: 'Four on the floor, off-beat hats, pumping chords', kit: 'boom', bpm: 124, make: house },
  { id: 'boombap', name: 'Boom bap', blurb: 'Swung, dusty drums and a round bass', kit: 'dust', bpm: 88, make: boomBap },
  { id: 'lofi', name: 'Lo-fi', blurb: 'Slow and loose, soft seventh chords, tape haze', kit: 'dust', bpm: 78, make: lofi },
  { id: 'drill', name: 'Drill', blurb: 'Skippy hats and an 808 that slides between notes', kit: 'glass', bpm: 142, make: drill },
];
