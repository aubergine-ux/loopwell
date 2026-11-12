// Factory sounds for the synth. Each one only lists what differs from a plain patch.

import { synth, type SynthParams } from './types';

export interface Preset {
  name: string;
  group: string;
  synth: SynthParams;
  /** A good octave to play it in (MIDI note). */
  note: number;
}

export const PRESET_GROUPS = ['Bass', 'Lead', 'Keys', 'Pad', 'Pluck', 'FX'];

// wavetable numbers: 4 pulse, 5 harmonic, 6 vowel, 7 bell, 8 sync, 9 fold, 10 organ, 11 digital
// mod destinations: 0 cutoff, 1 pitch, 2 osc 1 shape, 3 osc 2 shape, 4 osc 2 pitch, 5 mix, 6 noise, 7 reso, 8 level, 9 pan, 10 detune
const P = (group: string, name: string, note: number, part: Partial<SynthParams>): Preset => ({ group, name, note, synth: synth(part) });

export const PRESETS: Preset[] = [
  P('Bass', 'Round Sub', 36, { wave: 3, uni: 1, cutoff: 60, reso: 0, env: 20, decay: 60, sustain: 100, release: 24, wave2: 2, semi2: 12, mix: 18 }),
  P('Bass', 'Acid Line', 36, { wave: 0, uni: 1, cutoff: 38, reso: 96, env: 92, decay: 36, sustain: 6, release: 14 }),
  P('Bass', 'Reese', 36, { wave: 0, uni: 5, detune: 46, spread: 70, cutoff: 52, reso: 20, env: 10, sustain: 127, release: 30, lfoAmt: 10, lfoRate: 20, lfoDest: 0 }),
  P('Bass', 'Wobble', 36, { wave: 4, pos: 40, uni: 2, detune: 14, cutoff: 30, reso: 60, env: 0, sustain: 127, release: 20, lfoShape: 0, lfoSync: true, lfoRate: 71, lfoAmt: 44, lfoDest: 0 }),
  P('Bass', 'FM Growl', 36, { wave: 9, pos: 30, uni: 1, cutoff: 70, reso: 30, env: 40, decay: 50, sustain: 80, release: 20, menvAmt: 50, menvDecay: 60, menvDest: 2 }),
  P('Bass', 'Pluck Bass', 36, { wave: 1, uni: 2, detune: 8, cutoff: 34, reso: 30, env: 80, decay: 40, sustain: 0, release: 20 }),
  P('Lead', 'Square One', 60, { wave: 1, uni: 2, detune: 9, cutoff: 86, reso: 20, env: 30, attack: 2, decay: 60, sustain: 70, release: 40 }),
  P('Lead', 'Super Saw', 60, { wave: 0, uni: 5, detune: 34, spread: 100, cutoff: 96, reso: 10, env: 20, attack: 4, decay: 70, sustain: 90, release: 50 }),
  P('Lead', 'Sync Sweep', 60, { wave: 8, pos: 10, uni: 2, detune: 10, spread: 40, cutoff: 110, reso: 10, env: 0, sustain: 110, release: 40, menvAmt: 56, menvAttack: 0, menvDecay: 80, menvDest: 2 }),
  P('Lead', 'Vibrato Sine', 72, { wave: 3, uni: 1, cutoff: 127, reso: 0, env: 0, attack: 10, sustain: 110, release: 50, lfoAmt: 7, lfoRate: 88, lfoDest: 1 }),
  P('Lead', 'Talker', 60, { wave: 6, pos: 0, uni: 2, detune: 6, cutoff: 110, reso: 0, env: 0, sustain: 110, release: 40, lfoShape: 1, lfoRate: 50, lfoAmt: 50, lfoDest: 2 }),
  P('Keys', 'Soft Keys', 60, { wave: 2, uni: 1, cutoff: 76, reso: 6, env: 40, decay: 76, sustain: 30, release: 50, wave2: 3, semi2: 12, mix: 30 }),
  P('Keys', 'Drawbars', 60, { wave: 10, pos: 50, uni: 1, cutoff: 110, reso: 0, env: 0, sustain: 127, release: 20, lfoAmt: 5, lfoRate: 92, lfoDest: 8 }),
  P('Keys', 'Glass Bell', 72, { wave: 7, pos: 24, uni: 1, cutoff: 120, reso: 0, env: 0, decay: 96, sustain: 0, release: 90, menvAmt: 20, menvDecay: 70, menvDest: 2 }),
  P('Keys', 'Chip', 60, { wave: 11, pos: 80, uni: 1, cutoff: 127, reso: 0, env: 0, decay: 50, sustain: 60, release: 20 }),
  P('Pad', 'Warm Pad', 60, { wave: 0, uni: 4, detune: 26, spread: 110, cutoff: 56, reso: 10, env: 30, attack: 90, decay: 90, sustain: 100, release: 100 }),
  P('Pad', 'Choir', 60, { wave: 6, pos: 20, uni: 4, detune: 20, spread: 100, cutoff: 96, reso: 0, env: 0, attack: 84, sustain: 120, release: 96, lfoRate: 22, lfoAmt: 16, lfoDest: 2 }),
  P('Pad', 'Slow Motion', 60, { wave: 5, pos: 10, uni: 3, detune: 18, spread: 90, cutoff: 100, reso: 14, env: 0, attack: 100, sustain: 127, release: 110, lfoShape: 1, lfoRate: 10, lfoAmt: 60, lfoDest: 2, wave2: 3, semi2: -12, mix: 40 }),
  P('Pluck', 'Marimba', 60, { wave: 3, uni: 1, cutoff: 100, reso: 0, env: 30, decay: 44, sustain: 0, release: 40, wave2: 7, pos2: 10, semi2: 12, mix: 34 }),
  P('Pluck', 'Stab', 60, { wave: 0, uni: 3, detune: 16, spread: 60, cutoff: 60, reso: 30, env: 70, decay: 44, sustain: 0, release: 36 }),
  P('Pluck', 'Harp', 60, { wave: 5, pos: 50, uni: 1, cutoff: 70, reso: 10, env: 60, decay: 60, sustain: 0, release: 70, menvAmt: -40, menvDecay: 50, menvDest: 2 }),
  P('FX', 'Riser', 60, { wave: 0, uni: 5, detune: 60, spread: 127, noise: 50, cutoff: 30, reso: 40, env: 0, attack: 110, sustain: 127, release: 60, menvAmt: 60, menvAttack: 120, menvDecay: 127, menvDest: 0 }),
  P('FX', 'Laser', 72, { wave: 1, uni: 1, cutoff: 127, reso: 0, env: 0, decay: 40, sustain: 0, release: 20, menvAmt: 63, menvDecay: 34, menvDest: 1 }),
  P('FX', 'Wind', 60, { wave: 3, mix: 0, noise: 127, uni: 1, cutoff: 60, reso: 80, env: 0, attack: 80, sustain: 127, release: 90, lfoShape: 4, lfoRate: 40, lfoAmt: 30, lfoDest: 0 }),
];
