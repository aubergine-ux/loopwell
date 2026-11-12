// A few beats to open, pull apart and steal from. They are plain projects
// built with a tiny text notation: X accent, x hit, o ghost, - rest.

import { MAX_STEPS, defaultTracks, emptyProject, newPattern, type Note, type Pattern, type Project } from './types';

const VEL: Record<string, number> = { X: 122, x: 100, o: 58 };

function row(s: string): number[] {
  const out = new Array<number>(MAX_STEPS).fill(0);
  [...s.replace(/\s/g, '')].forEach((c, i) => { if (i < MAX_STEPS) out[i] = VEL[c] ?? 0; });
  return out;
}

/** [step, pitch, length?, velocity?] or [step, [pitches], length?, velocity?] for chords. */
type N = [number, number | number[], number?, number?];
const notes = (list: N[]): Note[] =>
  list.flatMap(([s, p, l = 1, v = 100]) => (Array.isArray(p) ? p : [p]).map((pitch) => ({ s, l, p: pitch, v })));

interface Pat {
  kick?: string; snare?: string; clap?: string; hat?: string; open?: string; perc?: string;
  bass?: N[]; lead?: N[];
}

function pattern(p: Pat): Pattern {
  const out = newPattern(8);
  [p.kick, p.snare, p.clap, p.hat, p.open, p.perc].forEach((s, i) => { if (s) out.steps[i] = row(s); });
  if (p.bass) out.notes[6] = notes(p.bass);
  if (p.lead) out.notes[7] = notes(p.lead);
  return out;
}

function beat(name: string, kit: string, pats: Pat[], edit: (p: Project) => void): Project {
  const p = emptyProject();
  p.name = name;
  p.tracks = defaultTracks(kit);
  pats.forEach((pat, i) => (p.patterns[i] = pattern(pat)));
  edit(p);
  return p;
}

const nightDrive = () => beat('Night Drive', 'boom', [
  {
    kick: 'X---x---x---x---', clap: '----x-------x---',
    hat: 'xo-oxo-oxo-oxo-o', open: '--x---x---x---x-', perc: '-------o------o-',
    bass: [[2, 33, 2], [6, 33, 2], [10, 33, 2], [13, 36], [14, 31, 2]],
    lead: [[0, 57], [3, 60], [6, 64, 2], [8, 69], [11, 64], [14, 60, 2]],
  },
  {
    kick: 'X---x---x---x---', clap: '----x-------x---', snare: '-------------oxx',
    hat: 'xo-oxo-oxo-oxo-o', open: '--x---x---x---x-', perc: '-------o------o-',
    bass: [[2, 29, 2], [6, 29, 2], [10, 31, 2], [13, 31], [14, 28, 2]],
    lead: [[0, 57], [3, 60], [6, 65, 2], [8, 69], [11, 67], [14, 64, 2]],
  },
  {
    hat: 'xo-oxo-oxo-oxo-o', open: '--x---x---x---x-', clap: '------------x-xx',
    bass: [[0, 33, 8], [8, 31, 8]],
    lead: [[0, [57, 60, 64], 6, 80], [8, [55, 59, 62], 6, 80]],
  },
], (p) => {
  p.bpm = 122; p.scaleRoot = 9; p.scaleType = 1;
  p.song = [0, 0, 1, 1, 0, 0, 1, 2]; p.songMode = true;
  p.tracks[0].vol = 108;
  p.tracks[3].vol = 62; p.tracks[4].vol = 66; p.tracks[4].decay = 86; p.tracks[5].vol = 60; p.tracks[5].rev = 60;
  p.tracks[2].rev = 46;
  p.tracks[6].note = 33;
  p.tracks[6].synth = { wave: 0, cutoff: 44, reso: 52, env: 62, attack: 0, decay: 42, sustain: 20, release: 18 };
  p.tracks[7].note = 57;
  p.tracks[7].synth = { wave: 1, cutoff: 62, reso: 36, env: 58, attack: 0, decay: 44, sustain: 14, release: 40 };
  p.tracks[7].vol = 76; p.tracks[7].dly = 78; p.tracks[7].rev = 56; p.tracks[7].pan = 12;
  p.fx.dlyTime = 3; p.fx.dlyFb = 58; p.fx.revSize = 84;
});

const dustLoop = () => beat('Dust Loop', 'dust', [
  {
    kick: 'X------x--x-----', snare: '----X----o--X---', clap: '----o-------o---',
    hat: 'x-o-x-o-x-o-x-oo', perc: '---o-----o------',
    bass: [[0, 38, 3], [7, 38], [10, 41, 2], [13, 36, 2]],
    lead: [[0, [62, 65, 69, 72], 6, 74], [8, [58, 62, 65, 69], 6, 74]],
  },
  {
    kick: 'X------x-xx-----', snare: '----X----o--X--o', clap: '----o-------o---',
    hat: 'x-o-x-o-x-o-x-o-', open: '--------------x-', perc: '---o-----o------',
    bass: [[0, 38, 3], [7, 38], [9, 43], [10, 41, 2], [13, 45, 2]],
    lead: [[0, [62, 65, 69, 72], 6, 74], [8, [57, 60, 64, 67], 6, 74]],
  },
], (p) => {
  p.bpm = 86; p.swing = 58; p.scaleRoot = 2; p.scaleType = 1;
  p.song = [0, 0, 0, 1]; p.songMode = true;
  p.tracks[2].vol = 70; p.tracks[3].vol = 70; p.tracks[4].vol = 60; p.tracks[5].vol = 74; p.tracks[5].pan = -24;
  p.tracks[1].rev = 30;
  p.tracks[6].note = 38;
  p.tracks[6].synth = { wave: 2, cutoff: 60, reso: 10, env: 30, attack: 0, decay: 60, sustain: 70, release: 30 };
  p.tracks[6].vol = 112;
  p.tracks[7].name = 'KEYS'; p.tracks[7].note = 62;
  p.tracks[7].synth = { wave: 2, cutoff: 58, reso: 8, env: 36, attack: 6, decay: 70, sustain: 40, release: 62 };
  p.tracks[7].vol = 74; p.tracks[7].rev = 70; p.tracks[7].dly = 30; p.tracks[7].filter = -14;
  p.fx.revSize = 60; p.fx.revDamp = 90; p.fx.dlyTime = 2; p.fx.dlyFb = 36;
  p.fx.compThresh = 56; p.fx.compRatio = 60; p.fx.compMakeup = 34;
});

const glassHours = () => beat('Glass Hours', 'glass', [
  {
    kick: 'X-----x-------x- x---------x--x--',
    clap: '--------X------- --------X-------',
    hat: 'x-x-x-x-x-x-xoxo x-x-x-oxx-x-x-x-',
    open: '---------------- --------------x-',
    perc: '---o------------ ---o--------o---',
    bass: [[0, 30, 6], [6, 30, 6], [14, 33, 2], [16, 30, 8], [26, 28, 3], [29, 28, 3]],
    lead: [[0, 73, 2], [3, 69], [6, 66, 3], [12, 68, 3], [16, 73, 2], [19, 76], [22, 73, 3], [28, 71, 4]],
  },
], (p) => {
  p.bpm = 140; p.steps = 32; p.scaleRoot = 6; p.scaleType = 1;
  p.tracks[0].vol = 104; p.tracks[2].rev = 52; p.tracks[3].vol = 58; p.tracks[4].vol = 56;
  p.tracks[5].vol = 64; p.tracks[5].rev = 80; p.tracks[5].dly = 70; p.tracks[5].pan = 30;
  p.tracks[6].name = 'SUB'; p.tracks[6].note = 30;
  p.tracks[6].synth = { wave: 3, cutoff: 96, reso: 0, env: 0, attack: 0, decay: 80, sustain: 110, release: 44 };
  p.tracks[6].vol = 118;
  p.tracks[7].name = 'BELL'; p.tracks[7].note = 66;
  p.tracks[7].synth = { wave: 2, cutoff: 80, reso: 20, env: 46, attack: 0, decay: 50, sustain: 10, release: 60 };
  p.tracks[7].vol = 78; p.tracks[7].dly = 96; p.tracks[7].rev = 84; p.tracks[7].pan = -16;
  p.fx.dlyTime = 3; p.fx.dlyFb = 64; p.fx.revSize = 100; p.fx.revDamp = 40;
});

const punchCard = () => beat('Punch Card', 'punch', [
  {
    kick: 'X-----x---x--x--', snare: '----X-------X---', clap: '------------o--o',
    hat: 'x-xox-xox-xox-xo', open: '--x-------x-----', perc: 'oxoxoxoxoxoxoxox',
    bass: [[0, 40], [2, 40], [3, 43], [5, 40], [7, 38], [8, 40, 2], [11, 35], [12, 38], [14, 40, 2]],
    lead: [[4, [64, 67, 71, 74], 1, 84], [10, [64, 67, 71, 74], 2, 84]],
  },
  {
    kick: 'X-----x---x--x-x', snare: '----X-------X-xx', clap: '------------o---',
    hat: 'x-xox-xox-xox-xo', open: '--x-------x-----', perc: 'oxoxoxoxoxoxoxox',
    bass: [[0, 45], [2, 45], [3, 48], [5, 45], [7, 43], [8, 45, 2], [11, 40], [12, 43], [14, 47, 2]],
    lead: [[4, [64, 69, 72, 76], 1, 84], [10, [66, 69, 74, 78], 2, 84]],
  },
], (p) => {
  p.bpm = 112; p.swing = 22; p.scaleRoot = 4; p.scaleType = 2;
  p.song = [0, 0, 0, 1]; p.songMode = true;
  p.tracks[3].vol = 62; p.tracks[4].vol = 58; p.tracks[5].vol = 44; p.tracks[5].pan = 34; p.tracks[2].vol = 76;
  p.tracks[1].rev = 34;
  p.tracks[6].note = 40;
  p.tracks[6].synth = { wave: 0, cutoff: 38, reso: 78, env: 84, attack: 0, decay: 34, sustain: 10, release: 14 };
  p.tracks[6].vol = 96;
  p.tracks[7].name = 'STAB'; p.tracks[7].note = 64;
  p.tracks[7].synth = { wave: 0, cutoff: 70, reso: 30, env: 50, attack: 0, decay: 40, sustain: 30, release: 36 };
  p.tracks[7].vol = 70; p.tracks[7].dly = 84; p.tracks[7].rev = 50; p.tracks[7].pan = -20;
  p.fx.dlyTime = 3; p.fx.dlyFb = 52; p.fx.revSize = 56;
});

export const DEMOS: { id: string; name: string; blurb: string; make: () => Project }[] = [
  { id: 'night-drive', name: 'Night Drive', blurb: 'Four-on-the-floor house, 122 bpm', make: nightDrive },
  { id: 'dust-loop', name: 'Dust Loop', blurb: 'Swung boom-bap, 86 bpm', make: dustLoop },
  { id: 'glass-hours', name: 'Glass Hours', blurb: 'Half-time with a sliding sub, 140 bpm', make: glassHours },
  { id: 'punch-card', name: 'Punch Card', blurb: 'Electro-funk with an acid bass, 112 bpm', make: punchCard },
];
