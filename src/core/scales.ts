export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const SCALES: { name: string; iv: number[] }[] = [
  { name: 'Major', iv: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Minor', iv: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dorian', iv: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Mixolydian', iv: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Phrygian', iv: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Minor pentatonic', iv: [0, 3, 5, 7, 10] },
  { name: 'Major pentatonic', iv: [0, 2, 4, 7, 9] },
  { name: 'Blues', iv: [0, 3, 5, 6, 7, 10] },
  { name: 'Harmonic minor', iv: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Chromatic', iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

const scale = (type: number) => SCALES[type] ?? SCALES[0];

export function inScale(pitch: number, root: number, type: number): boolean {
  return scale(type).iv.includes((((pitch - root) % 12) + 12) % 12);
}

/** Nearest in-scale pitch (ties go down). */
export function snapToScale(pitch: number, root: number, type: number): number {
  for (let d = 0; d < 12; d++) {
    if (inScale(pitch - d, root, type)) return pitch - d;
    if (inScale(pitch + d, root, type)) return pitch + d;
  }
  return pitch;
}

/** Every in-scale MIDI pitch from lo to hi, ascending. */
export function scalePitches(root: number, type: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) if (inScale(p, root, type)) out.push(p);
  return out;
}

/** The pitch `degree` scale steps above the first scale root at or below `base`. */
export function degreeToPitch(root: number, type: number, base: number, degree: number): number {
  const iv = scale(type).iv;
  const start = base - ((((base - root) % 12) + 12) % 12);
  const oct = Math.floor(degree / iv.length);
  return start + oct * 12 + iv[((degree % iv.length) + iv.length) % iv.length];
}

export function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}
