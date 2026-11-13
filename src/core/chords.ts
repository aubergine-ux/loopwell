// Chords that belong to the song's key: stack every other note of the scale
// on each of its degrees, then work out what the result is called.

import { NOTE_NAMES, SCALES } from './scales';

export interface Chord {
  /** Scale degree the chord is built on, from 0. */
  degree: number;
  /** e.g. "Am7". */
  name: string;
  /** e.g. "vi". */
  numeral: string;
  /** Semitones above the song's root note, ascending. */
  tones: number[];
}

export const CHORD_SIZES = [3, 4, 5];
export const CHORD_SIZE_LABELS = ['Triad', '7th', '9th'];

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const QUALITIES: [string, string, boolean][] = [
  // intervals above the chord's root -> suffix, and whether the numeral is lower-case
  ['4,7', '', false], ['3,7', 'm', true], ['3,6', 'dim', true], ['4,8', 'aug', false],
  ['2,7', 'sus2', false], ['5,7', 'sus4', false],
  ['4,7,11', 'maj7', false], ['4,7,10', '7', false], ['3,7,10', 'm7', true], ['3,6,10', 'm7♭5', true],
  ['3,7,11', 'm(maj7)', true], ['3,6,9', 'dim7', true], ['4,8,11', 'maj7♯5', false],
  ['4,7,11,14', 'maj9', false], ['4,7,10,14', '9', false], ['3,7,10,14', 'm9', true], ['3,7,10,13', 'm7♭9', true],
  ['4,7,10,13', '7♭9', false], ['3,6,10,13', 'm7♭5♭9', true], ['3,6,10,14', 'm9♭5', true], ['3,7,11,14', 'm(maj9)', true],
];

/** The chord on each degree of a scale. Scales with fewer than seven notes still stack every other note. */
export function scaleChords(root: number, type: number, size = 3): Chord[] {
  const iv = (SCALES[type] ?? SCALES[0]).iv;
  if (iv.length > 8) return []; // chromatic: every chord is "in key", so there is nothing to suggest
  return iv.map((base, degree) => {
    const tones: number[] = [];
    for (let k = 0; k < size; k++) {
      const i = degree + k * 2;
      tones.push(iv[i % iv.length] + 12 * Math.floor(i / iv.length));
    }
    const rel = tones.slice(1).map((t) => t - base).join(',');
    const q = QUALITIES.find((x) => x[0] === rel);
    const letter = NOTE_NAMES[(root + base) % 12];
    const num = NUMERALS[degree % 7];
    return { degree, name: letter + (q ? q[1] : ''), numeral: q?.[2] ? num.toLowerCase() : num, tones };
  });
}

/** MIDI pitches of a chord whose root sits in the octave starting at `octaveBase` (a multiple of 12), moved up `inversion` times. */
export function chordPitches(chord: Chord, root: number, octaveBase: number, inversion = 0): number[] {
  const out = chord.tones.map((t) => octaveBase + root + t);
  for (let i = 0; i < inversion; i++) out.push(out.shift()! + 12);
  return out.filter((p) => p >= 0 && p <= 127);
}
