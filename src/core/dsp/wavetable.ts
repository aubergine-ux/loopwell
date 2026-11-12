// Wavetables for the synth. Each table is a row of single-cycle waves that an
// oscillator can morph through. They are computed, not sampled: every frame is
// described by a formula, turned into harmonics with an FFT, and stored
// band-limited at several levels so high notes never alias.

export const WT_SIZE = 1024;
export const WT_FRAMES = 16;
const MIPS = 9; // level m keeps harmonics up to 512 >> m

export const WAVETABLES: { id: string; name: string }[] = [
  { id: 'pwm', name: 'Pulse' },
  { id: 'harm', name: 'Harmonic' },
  { id: 'vowel', name: 'Vowel' },
  { id: 'bell', name: 'Bell' },
  { id: 'sync', name: 'Sync' },
  { id: 'fold', name: 'Fold' },
  { id: 'organ', name: 'Organ' },
  { id: 'digital', name: 'Digital' },
];

/** In-place radix-2 FFT. `inverse` leaves the result unscaled. */
export function fft(re: Float32Array | Float64Array, im: Float32Array | Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const TAU = 2 * Math.PI;
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240]]; // a e i o u

/** One cycle of table `id` at morph position x (0..1), phase p (0..1). */
function shape(id: string, x: number, p: number): number {
  switch (id) {
    case 'pwm': return p < 0.5 - x * 0.45 ? 1 : -1;
    case 'harm': {
      // a saw whose harmonics open up from the bottom
      const top = 1 + x * x * 60;
      let s = 0;
      for (let h = 1; h <= top + 1; h++) s += (Math.sin(TAU * p * h) / h) * Math.min(1, top + 1 - h);
      return s * 0.6;
    }
    case 'vowel': {
      // formant peaks over a 110 Hz fundamental, gliding a-e-i-o-u
      const v = x * (VOWELS.length - 1), i = Math.min(VOWELS.length - 2, Math.floor(v)), f = v - i;
      let s = 0;
      for (let h = 1; h <= 40; h++) {
        let amp = 0;
        for (let k = 0; k < 3; k++) {
          const fc = VOWELS[i][k] + (VOWELS[i + 1][k] - VOWELS[i][k]) * f;
          const d = (h * 110 - fc) / (60 + k * 30);
          amp += Math.exp(-0.5 * d * d) / (k + 1);
        }
        s += Math.sin(TAU * p * h) * (amp + 0.6 / (h * h));
      }
      return s * 0.5;
    }
    case 'bell': return Math.sin(TAU * p + (0.2 + x * 6) * Math.sin(TAU * p * 3.0 + x) * (1 - 0.5 * x * Math.cos(TAU * p)));
    case 'sync': { const q = (p * (1 + x * 7)) % 1; return (2 * q - 1) * (1 - p * 0.5); }
    case 'fold': return Math.sin((1 + x * 9) * Math.sin(TAU * p) * 1.2);
    case 'organ': {
      const bars = [1, 2, 3, 4, 6, 8, 10, 12, 16];
      let s = 0;
      bars.forEach((h, k) => { s += Math.sin(TAU * p * h) * Math.max(0, 1 - Math.abs(k - x * (bars.length - 1)) / 2.2); });
      return s * 0.5;
    }
    default: { // digital: a sine through fewer and fewer steps
      const steps = Math.round(24 - x * 21);
      return Math.round(Math.sin(TAU * p) * steps) / steps + (Math.round(Math.sin(TAU * p * 2) * 2) / 8) * x;
    }
  }
}

export interface Wavetable {
  /** [mip][frame] single cycles of WT_SIZE samples. */
  frames: Float32Array[][];
}

const cache = new Map<number, Wavetable>();

/** Build (once) and return table number `index`. Takes a few milliseconds the first time. */
export function wavetable(index: number): Wavetable {
  let t = cache.get(index);
  if (t) return t;
  const id = (WAVETABLES[index] ?? WAVETABLES[0]).id;
  const frames: Float32Array[][] = Array.from({ length: MIPS }, () => []);
  const re = new Float64Array(WT_SIZE), im = new Float64Array(WT_SIZE);
  const tr = new Float64Array(WT_SIZE), ti = new Float64Array(WT_SIZE);
  for (let f = 0; f < WT_FRAMES; f++) {
    const x = f / (WT_FRAMES - 1);
    for (let i = 0; i < WT_SIZE; i++) { re[i] = shape(id, x, i / WT_SIZE); im[i] = 0; }
    fft(re, im);
    re[0] = im[0] = 0; // no DC
    let peak = 0;
    for (let m = 0; m < MIPS; m++) {
      const top = (WT_SIZE / 2) >> m;
      tr.fill(0); ti.fill(0);
      for (let h = 1; h < top; h++) {
        tr[h] = re[h]; ti[h] = im[h];
        tr[WT_SIZE - h] = re[WT_SIZE - h]; ti[WT_SIZE - h] = im[WT_SIZE - h];
      }
      fft(tr, ti, true);
      const out = new Float32Array(WT_SIZE);
      for (let i = 0; i < WT_SIZE; i++) out[i] = tr[i] / WT_SIZE;
      if (m === 0) for (let i = 0; i < WT_SIZE; i++) peak = Math.max(peak, Math.abs(out[i]));
      // every level is scaled by the full-band peak, so loudness doesn't jump between levels
      const g = peak > 1e-9 ? 0.9 / peak : 1;
      for (let i = 0; i < WT_SIZE; i++) out[i] *= g;
      frames[m].push(out);
    }
  }
  t = { frames };
  cache.set(index, t);
  return t;
}

/** The level whose top harmonic stays below Nyquist for a cycle advancing `dt` per sample. */
export function mipFor(dt: number): number {
  // harmonics allowed: 0.5 / dt. Level m has (WT_SIZE / 2) >> m of them.
  let m = 0;
  let top = WT_SIZE / 2;
  const allowed = 0.5 / dt;
  while (top > allowed && m < MIPS - 1) { top >>= 1; m++; }
  return m;
}
