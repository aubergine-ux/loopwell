// What a sample is, worked out from its audio: tempo, key, and the outline
// drawn in the browser. All of it runs on the main thread when a sample is
// looked at, never on the audio thread.

import { NOTE_NAMES } from './scales';

function mono(l: Float32Array, r?: Float32Array): Float32Array {
  if (!r || r === l) return l;
  const m = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) * 0.5;
  return m;
}

/** `width` pairs of (lowest, highest) sample values, for drawing a waveform. */
export function waveformPeaks(l: Float32Array, width: number): Float32Array {
  const out = new Float32Array(width * 2);
  const per = l.length / width;
  for (let x = 0; x < width; x++) {
    const a = Math.floor(x * per), b = Math.max(a + 1, Math.floor((x + 1) * per));
    let lo = 1, hi = -1;
    // long files are skipped through rather than read whole: an outline doesn't need every sample
    const stride = Math.max(1, Math.floor((b - a) / 64));
    for (let i = a; i < b && i < l.length; i += stride) {
      const v = l[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[x * 2] = lo > hi ? 0 : lo;
    out[x * 2 + 1] = lo > hi ? 0 : hi;
  }
  return out;
}

const HOP = 256;

/** How much louder each moment is than the one before: peaks where hits are. */
function onsetCurve(x: Float32Array): Float32Array {
  const n = Math.floor(x.length / HOP);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let k = i * HOP, end = k + HOP; k < end; k++) e += x[k] * x[k];
    e = Math.log(1 + 1000 * Math.sqrt(e / HOP));
    env[i] = e > prev ? e - prev : 0;
    prev = e;
  }
  return env;
}

/**
 * Tempo of a loop, or null if it doesn't have a steady one (a single hit, a pad).
 * The hits give a rough tempo; if a whole number of bars at a nearby tempo fits
 * the file exactly, that is taken to be the real one, since loops are cut to length.
 */
export function detectBpm(l: Float32Array, sampleRate: number, r?: Float32Array): number | null {
  const seconds = l.length / sampleRate;
  if (seconds < 1.2) return null;
  const env = onsetCurve(mono(l, r));
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let power = 0;
  for (let i = 0; i < n; i++) { env[i] -= mean; power += env[i] * env[i]; }
  if (power < 1e-6) return null;
  // a tempo needs several hits to show itself: one hit and its tail is not a loop
  let top = 0, hits = 0;
  for (let i = 0; i < n; i++) if (env[i] > top) top = env[i];
  for (let i = 1; i < n - 1; i++) if (env[i] > top * 0.3 && env[i] >= env[i - 1] && env[i] > env[i + 1]) hits++;
  if (hits < 4) return null;
  const rate = sampleRate / HOP; // onset-curve frames per second
  const lagOf = (bpm: number) => (60 / bpm) * rate;
  const lo = Math.floor(lagOf(200)), hi = Math.min(n - 1, Math.ceil(lagOf(60)));
  if (hi <= lo + 2) return null;
  const last = Math.min(n - 1, hi * 2 + 1);
  const ac = new Float32Array(last + 1);
  for (let lag = 1; lag <= last; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (n - lag);
  }
  const at = (lag: number) => { const k = Math.round(lag); return k >= 1 && k <= last ? ac[k] : 0; };
  let best = -1, score = 0;
  for (let lag = lo; lag <= hi; lag++) {
    if (ac[lag] <= 0 || ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    // Hits repeat at every multiple of the shortest gap between them, so the curve alone can't tell the beat from
    // a beat and a half. Beats divide in two, not three: favour a gap whose half and double also line up, and
    // mark down one that only works in thirds. Then lean towards tempos people actually use.
    const bpm = (60 * rate) / lag;
    const fit = ac[lag] + 0.5 * Math.max(0, at(lag / 2)) + 0.5 * Math.max(0, at(lag * 2)) - 0.6 * Math.max(0, at(lag / 3));
    const w = fit * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.8, 2));
    if (w > score) { score = w; best = lag; }
  }
  if (best < 0 || ac[best] < 0.12 * (power / n)) return null;
  // the true peak lies between two frames
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  let bpm = (60 * rate) / (best + shift);
  // a loop is cut to a whole number of beats: if one fits, trust the length over the estimate
  for (const beats of [4, 8, 16, 32, 64, 2, 12, 24, 6, 3]) {
    const exact = (beats * 60) / seconds;
    for (const m of [1, 2, 0.5]) {
      const cand = exact * m;
      if (cand >= 55 && cand <= 210 && Math.abs(cand / bpm - 1) < 0.035) return Math.round(cand * 10) / 10;
    }
  }
  bpm = Math.round(bpm * 10) / 10;
  return bpm >= 55 && bpm <= 210 ? bpm : null;
}

// How strongly each note of the scale is felt in a major and a minor key (Krumhansl & Kessler).
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyGuess {
  root: number; // 0..11
  minor: boolean;
  /** 0..1: how clearly this key stood out. */
  confidence: number;
  name: string;
}

function correlate(chroma: number[], profile: number[], root: number): number {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += chroma[(i + root) % 12]; my += profile[i]; }
  mx /= 12; my /= 12;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) {
    const x = chroma[(i + root) % 12] - mx, y = profile[i] - my;
    sxy += x * y; sxx += x * x; syy += y * y;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** The key a sample is in, or null for things with no clear pitch (drums, noise). */
export function detectKey(l: Float32Array, sampleRate: number, r?: Float32Array): KeyGuess | null {
  const src = mono(l, r);
  // pitch lives below a few kHz, so work on a lower sample rate: it is much less to listen through
  const dec = Math.max(1, Math.floor(sampleRate / 11025));
  const sr = sampleRate / dec;
  const n = Math.floor(src.length / dec);
  const WIN = 4096;
  if (n < WIN) return null;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += src[i * dec + k];
    x[i] = s / dec;
  }
  const win = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const LOW = 36, HIGH = 96; // C2..B6
  const coef = new Float64Array(HIGH - LOW);
  for (let p = LOW; p < HIGH; p++) coef[p - LOW] = 2 * Math.cos((2 * Math.PI * 440 * Math.pow(2, (p - 69) / 12)) / sr);
  const chroma = new Array<number>(12).fill(0);
  const frame = new Float32Array(WIN);
  const hop = Math.max(WIN / 2, Math.floor((n - WIN) / 200)); // at most ~200 frames, however long the file
  let total = 0, tonal = 0;
  for (let at = 0; at + WIN <= n; at += hop) {
    let energy = 0;
    for (let i = 0; i < WIN; i++) { frame[i] = x[at + i] * win[i]; energy += frame[i] * frame[i]; }
    if (energy < 1e-5) continue;
    let sum = 0, peak = 0;
    const mags = new Float64Array(HIGH - LOW);
    for (let k = 0; k < coef.length; k++) {
      // Goertzel: the strength of one frequency without a full spectrum
      let s1 = 0, s2 = 0;
      const c = coef[k];
      for (let i = 0; i < WIN; i++) { const s0 = frame[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
      mags[k] = m;
      sum += m;
      if (m > peak) peak = m;
    }
    if (!sum) continue;
    for (let k = 0; k < coef.length; k++) chroma[(k + LOW) % 12] += mags[k] / sum;
    // a note stands far above the average bin; noise doesn't
    tonal += peak / (sum / coef.length);
    total++;
  }
  if (!total || tonal / total < 6) return null;
  let best = -2, second = -2, root = 0, minor = false;
  for (let k = 0; k < 12; k++) for (const m of [false, true]) {
    const c = correlate(chroma, m ? MINOR : MAJOR, k);
    if (c > best) { second = best; best = c; root = k; minor = m; } else if (c > second) second = c;
  }
  if (best < 0.5) return null;
  return { root, minor, confidence: Math.max(0, Math.min(1, best * 0.6 + (best - second) * 4)), name: `${NOTE_NAMES[root]} ${minor ? 'minor' : 'major'}` };
}
