// Synthesises the built-in drum kits into public/kits/<kit>/<slot>.wav.
// Everything here is generated from oscillators and noise, so the results are
// original and released as CC0. Run with: npm run kits

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../src/core/wav';

const SR = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/kits');
type Buf = Float32Array;

// --- building blocks -------------------------------------------------------

let seed = 1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const make = (sec: number, f: (t: number, i: number) => number): Buf => {
  const b = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < b.length; i++) b[i] = f(i / SR, i);
  return b;
};
const noise = (sec: number) => make(sec, () => rnd() * 2 - 1);
const decay = (t: number, tau: number) => Math.exp(-t / tau);

/** Sine (or triangle) whose pitch falls from f0 to f1 with time constant tp. */
function sweep(sec: number, f0: number, f1: number, tp: number, tri = false): Buf {
  let ph = 0;
  return make(sec, (t) => {
    ph += (f1 + (f0 - f1) * decay(t, tp)) / SR;
    const x = ph % 1;
    return tri ? (x < 0.5 ? 4 * x - 1 : 3 - 4 * x) : Math.sin(2 * Math.PI * ph);
  });
}

/** Two-operator FM. The index decays with time constant ti. */
function fm(sec: number, fc0: number, fc1: number, tp: number, ratio: number, idx: number, ti: number): Buf {
  let pc = 0, pm = 0;
  return make(sec, (t) => {
    const f = fc1 + (fc0 - fc1) * decay(t, tp);
    pc += f / SR;
    pm += (f * ratio) / SR;
    return Math.sin(2 * Math.PI * pc + idx * decay(t, ti) * Math.sin(2 * Math.PI * pm));
  });
}

/** A cluster of square waves, the classic recipe for metallic hats and cymbals. */
function metal(sec: number, freqs: number[]): Buf {
  const ph = freqs.map(() => rnd());
  return make(sec, () => {
    let x = 0;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] += freqs[k] / SR;
      x += ph[k] % 1 < 0.5 ? 1 : -1;
    }
    return x / freqs.length;
  });
}

function shape(b: Buf, f: (t: number) => number): Buf {
  for (let i = 0; i < b.length; i++) b[i] *= f(i / SR);
  return b;
}
const env = (b: Buf, tau: number, attack = 0) =>
  shape(b, (t) => (attack && t < attack ? t / attack : decay(t - attack, tau)));

function biquad(b: Buf, type: 'lp' | 'hp' | 'bp', f: number, q = 0.707): Buf {
  const w = (2 * Math.PI * f) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') { b1 = 1 - cs; b0 = b2 = b1 / 2; }
  else if (type === 'hp') { b1 = -(1 + cs); b0 = b2 = (1 + cs) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    b[i] = y;
  }
  return b;
}

function mix(...parts: [Buf, number][]): Buf {
  const out = new Float32Array(Math.max(...parts.map(([b]) => b.length)));
  for (const [b, g] of parts) for (let i = 0; i < b.length; i++) out[i] += b[i] * g;
  return out;
}

const drive = (b: Buf, amt: number) => {
  const n = Math.tanh(amt);
  for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i] * amt) / n;
  return b;
};

/** Bit-depth and sample-rate reduction for the lo-fi kit. */
function crush(b: Buf, bits: number, hold: number): Buf {
  const q = Math.pow(2, bits - 1);
  let held = 0;
  for (let i = 0; i < b.length; i++) {
    if (i % hold === 0) held = Math.round(b[i] * q) / q;
    b[i] = held;
  }
  return b;
}

/** Normalise, trim the silent tail and fade the last few ms. */
function finish(b: Buf, peak = 0.92): Buf {
  let max = 0;
  for (const x of b) max = Math.max(max, Math.abs(x));
  let end = b.length;
  while (end > 1 && Math.abs(b[end - 1]) < max * 0.0006) end--;
  end = Math.min(b.length, end + 64);
  const out = b.slice(0, end);
  const fade = Math.min(end, Math.round(SR * 0.008));
  for (let i = 0; i < end; i++) {
    out[i] *= peak / max;
    if (i >= end - fade) out[i] *= (end - i) / fade;
  }
  return out;
}

/** The hand-clap envelope: a few quick bursts, then a longer tail. */
const clapEnv = (gap: number, tail: number) => (t: number) => {
  let e = 0;
  for (let k = 0; k < 3; k++) {
    const u = t - k * gap;
    if (u >= 0 && u < gap) e = Math.max(e, decay(u, gap * 0.45));
  }
  const u = t - 3 * gap;
  return u >= 0 ? decay(u, tail) : e;
};

const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 8.1);

// --- the kits --------------------------------------------------------------

const boom: Record<string, () => Buf> = {
  kick: () => drive(mix(
    [env(sweep(1.1, 165, 47, 0.045), 0.33), 1],
    [env(biquad(noise(0.02), 'lp', 3000), 0.004), 0.35]), 1.6),
  snare: () => mix(
    [env(sweep(0.4, 260, 178, 0.02), 0.07), 0.8],
    [env(sweep(0.4, 420, 331, 0.02), 0.045), 0.45],
    [env(biquad(biquad(noise(0.4), 'hp', 1400), 'lp', 9000), 0.11), 0.75]),
  clap: () => shape(biquad(biquad(noise(0.6), 'bp', 1150, 1.6), 'hp', 500), clapEnv(0.011, 0.11)),
  hat: () => env(biquad(biquad(metal(0.2, HAT_FREQS), 'bp', 10000, 1.2), 'hp', 7000), 0.028),
  open: () => env(biquad(biquad(metal(0.9, HAT_FREQS), 'bp', 10000, 1.2), 'hp', 7000), 0.26),
  tom: () => mix(
    [env(sweep(0.8, 210, 128, 0.06), 0.22), 1],
    [env(biquad(noise(0.05), 'lp', 2000), 0.01), 0.2]),
  rim: () => biquad(mix(
    [env(sweep(0.08, 1720, 1700, 0.01), 0.012), 0.7],
    [env(sweep(0.08, 510, 500, 0.01), 0.016), 0.6],
    [env(noise(0.01), 0.002), 0.5]), 'hp', 300),
  perc: () => shape(biquad(metal(0.6, [540, 800]), 'bp', 780, 2.5), (t) => 0.75 * decay(t, 0.018) + 0.25 * decay(t, 0.16)),
  crash: () => env(biquad(mix([metal(1.9, HAT_FREQS.map((f) => f * 0.72)), 0.7], [noise(1.9), 0.5]), 'hp', 5200), 0.55),
  sub: () => drive(env(sweep(1.9, 82, 55, 0.035), 0.75), 2.2),
};

const punch: Record<string, () => Buf> = {
  kick: () => drive(mix(
    [env(sweep(0.6, 260, 52, 0.028), 0.17), 1],
    [env(biquad(noise(0.03), 'hp', 1500), 0.003), 0.5]), 2.6),
  snare: () => drive(mix(
    [env(sweep(0.45, 330, 196, 0.012, true), 0.055), 0.7],
    [env(biquad(biquad(noise(0.45), 'hp', 900), 'lp', 11000), 0.14), 1]), 1.5),
  clap: () => shape(biquad(biquad(noise(0.8), 'bp', 1500, 1.1), 'hp', 700), clapEnv(0.009, 0.18)),
  hat: () => env(biquad(mix([noise(0.15), 1], [metal(0.15, HAT_FREQS), 0.5]), 'hp', 8500), 0.022),
  open: () => env(biquad(mix([noise(1), 1], [metal(1, HAT_FREQS), 0.6]), 'hp', 8000), 0.3),
  tom: () => drive(mix(
    [env(sweep(0.9, 190, 96, 0.05), 0.24), 1],
    [env(biquad(noise(0.06), 'bp', 1800, 1), 0.012), 0.4]), 1.4),
  rim: () => drive(biquad(mix(
    [env(sweep(0.1, 480, 470, 0.01, true), 0.014), 0.7],
    [env(sweep(0.1, 1110, 1100, 0.01, true), 0.011), 0.6],
    [env(sweep(0.1, 1660, 1650, 0.01, true), 0.009), 0.5]), 'hp', 350), 2),
  perc: () => env(biquad(noise(0.25), 'bp', 6200, 1.4), 0.045, 0.006),
  crash: () => env(biquad(mix([noise(2.1), 1], [metal(2.1, HAT_FREQS.map((f) => f * 0.63)), 0.5]), 'hp', 4200), 0.62),
  sub: () => drive(env(sweep(1.5, 110, 55, 0.02), 0.55), 4),
};

const lofi = (b: Buf, lp = 6000, hold = 3, bits = 9) => biquad(crush(drive(b, 1.8), bits, hold), 'lp', lp);
const dust: Record<string, () => Buf> = {
  kick: () => lofi(mix(
    [env(sweep(0.7, 130, 50, 0.05), 0.24), 1],
    [env(biquad(noise(0.03), 'lp', 1200), 0.008), 0.5]), 2800, 2, 10),
  snare: () => lofi(mix(
    [env(sweep(0.4, 240, 188, 0.03), 0.06), 0.6],
    [env(biquad(noise(0.4), 'bp', 2600, 0.6), 0.1), 1]), 5200),
  clap: () => lofi(shape(biquad(noise(0.3), 'bp', 2100, 1.4), clapEnv(0.007, 0.05)), 5500),
  hat: () => lofi(env(biquad(noise(0.15), 'bp', 7200, 1), 0.02, 0.002), 7500, 2),
  open: () => lofi(env(biquad(noise(0.7), 'bp', 6800, 0.8), 0.19, 0.002), 7500, 2),
  tom: () => lofi(env(sweep(0.7, 150, 88, 0.07), 0.2), 2500),
  rim: () => lofi(mix(
    [env(sweep(0.1, 830, 800, 0.01), 0.018), 1],
    [env(noise(0.01), 0.002), 0.5]), 5000),
  perc: () => lofi(mix(
    [env(sweep(0.4, 330, 282, 0.015), 0.085), 1],
    [env(biquad(noise(0.02), 'bp', 1500, 1), 0.004), 0.5]), 4000),
  crash: () => lofi(mix(
    [env(biquad(metal(1.6, HAT_FREQS.map((f) => f * 0.5)), 'bp', 5200, 0.7), 0.42), 1],
    [env(biquad(noise(0.05), 'hp', 4000), 0.012), 0.5]), 7000, 2),
  sub: () => lofi(env(sweep(1.6, 70, 55, 0.05), 0.6), 1800, 2, 10),
};

const glass: Record<string, () => Buf> = {
  kick: () => drive(env(sweep(0.6, 520, 46, 0.018), 0.2), 2),
  snare: () => mix(
    [env(fm(0.35, 240, 205, 0.02, 1.47, 3, 0.03), 0.06), 0.8],
    [env(biquad(noise(0.35), 'bp', 3400, 0.9), 0.09), 0.9]),
  clap: () => shape(biquad(noise(0.45), 'hp', 2400), clapEnv(0.008, 0.07)),
  hat: () => env(biquad(fm(0.15, 8000, 8000, 1, 1.4127, 5, 0.2), 'hp', 6500), 0.018),
  open: () => env(biquad(fm(0.8, 8000, 8000, 1, 1.4127, 5, 0.6), 'hp', 6500), 0.2),
  tom: () => env(fm(0.7, 240, 150, 0.04, 1.4, 2.2, 0.05), 0.2),
  rim: () => env(fm(0.12, 1250, 1200, 0.01, 2.76, 2, 0.01), 0.016),
  perc: () => env(fm(1.2, 880, 880, 1, 3.5, 3.2, 0.12), 0.3),
  crash: () => env(biquad(mix([fm(1.8, 5200, 5200, 1, 1.9, 9, 1.2), 0.8], [noise(1.8), 0.5]), 'hp', 4500), 0.5),
  sub: () => env(mix([sweep(1.6, 60, 55, 0.03), 1], [fm(1.6, 110, 110, 1, 2, 1.2, 0.15), 0.25]), 0.6),
};

const kits: Record<string, Record<string, () => Buf>> = { boom, punch, dust, glass };
let bytes = 0;
for (const [kit, sounds] of Object.entries(kits)) {
  mkdirSync(join(OUT, kit), { recursive: true });
  let i = 0;
  for (const [slot, gen] of Object.entries(sounds)) {
    seed = kit.length * 7919 + ++i * 104729;
    const wav = encodeWav([finish(gen())], SR, 16);
    writeFileSync(join(OUT, kit, `${slot}.wav`), wav);
    bytes += wav.length;
  }
}
console.log(`wrote ${Object.keys(kits).length} kits, ${(bytes / 1024).toFixed(0)} kB`);
