// Vocal effects: pitch correction, harmonies, doubling and formant shifting,
// plus the compressor and de-esser a vocal chain needs. The first three are
// one machine underneath. It follows the pitch of a single voice and rebuilds
// the sound from short overlapping grains, one per cycle of the voice: how
// closely the grains are spaced sets the pitch that comes out, and how fast
// each is read sets where the formants (the "size" of the voice) sit. The two
// can therefore be moved separately, which plain speeding-up can't do.
//
// It has to hear a little ahead, so what comes out is about 30 ms late.

import { SCALES } from '../scales';
import type { Insert } from './inserts';

const LOWEST_HZ = 85;
/** How many cycles of the lowest voice the machine waits before it speaks. */
const WAIT = 2.5;
const HIGHEST_HZ = 900;

/** Follows the pitch of one voice. Feed it every sample; it listens at a lower sample rate to keep the cost down. */
class PitchFollower {
  /** Length of one cycle in samples (at the full rate), or 0 when nothing with a pitch is sounding. */
  period = 0;
  private dec: number;
  private acc = 0;
  private accN = 0;
  private ring: Float32Array;
  private w = 0;
  private since = 0;
  private minLag: number;
  private maxLag: number;
  private d: Float32Array;
  private static WIN = 256;
  private static HOP = 64;

  constructor(sr: number) {
    this.dec = Math.max(1, Math.round(sr / 12000));
    const rate = sr / this.dec;
    this.minLag = Math.floor(rate / HIGHEST_HZ);
    this.maxLag = Math.ceil(rate / LOWEST_HZ);
    this.ring = new Float32Array(1024);
    this.d = new Float32Array(this.maxLag + 2);
  }

  push(x: number): void {
    this.acc += x;
    if (++this.accN < this.dec) return;
    this.ring[this.w] = this.acc / this.dec;
    this.w = (this.w + 1) & 1023;
    this.acc = 0;
    this.accN = 0;
    if (++this.since >= PitchFollower.HOP) { this.since = 0; this.analyse(); }
  }

  /** YIN: find the shortest lag at which the signal repeats itself. */
  private analyse(): void {
    const { ring, d, minLag, maxLag } = this;
    const W = PitchFollower.WIN;
    const start = (this.w - W - maxLag - 1 + 2048) & 1023;
    let energy = 0;
    for (let i = 0; i < W; i++) { const v = ring[(start + i) & 1023]; energy += v * v; }
    if (energy / W < 1e-6) { this.period = 0; return; }
    let run = 0, best = -1;
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = ring[(start + i) & 1023] - ring[(start + i + lag) & 1023]; s += v * v; }
      run += s;
      d[lag] = run ? (s * lag) / run : 1;
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (d[lag] < 0.18 && d[lag] <= d[lag + 1]) { best = lag; break; }
    }
    if (best < 0) { this.period = 0; return; }
    const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1];
    const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
    this.period = (best + shift) * this.dec;
  }
}

/** One stream of grains: a voice at some pitch ratio, written into an output ring. */
class Stream {
  next = 0; // output time of the next grain's centre
  lastIn = 0; // input time the last grain was centred on
  ratio = 1; // pitch out / pitch in, smoothed
}

const RING = 16384;
const MASK = RING - 1;

/**
 * The grain machine. Holds the last third of a second of input, follows its pitch, and lets any number of
 * streams rebuild it at their own pitch and formant settings, all the same fixed time late.
 */
class Voicer {
  readonly latency: number;
  readonly follower: PitchFollower;
  private inL = new Float32Array(RING);
  private inR = new Float32Array(RING);
  private outL = new Float32Array(RING);
  private outR = new Float32Array(RING);
  t = 0;
  private unvoiced: number;

  constructor(private sr: number) {
    this.follower = new PitchFollower(sr);
    // enough to hold a whole grain of the lowest voice read at the fastest formant setting
    this.latency = Math.ceil((sr / LOWEST_HZ) * WAIT);
    this.unvoiced = Math.round(sr * 0.005);
  }

  /** Take in one sample. */
  write(l: number, r: number): void {
    const i = this.t & MASK;
    this.inL[i] = l; this.inR[i] = r;
    this.follower.push((l + r) * 0.5);
  }

  /** The input as it was `latency` samples ago: the untouched voice, in time with what the streams produce. */
  dry(right: boolean): number {
    return (right ? this.inR : this.inL)[(this.t - this.latency) & MASK];
  }

  /**
   * Let a stream add any grain that is due. `ratio` is the pitch change, `formant` how much faster (above 1) or
   * slower each grain is read, `gl` and `gr` its level left and right.
   */
  run(s: Stream, ratio: number, formant: number, gl: number, gr: number): void {
    const P = this.follower.period;
    const voiced = P > 0;
    const half = voiced ? P : this.unvoiced; // a grain is two cycles long, or 10 ms of anything without a pitch
    // a stream that has been idle (a harmony voice switched on again) picks up from now, not from where it stopped
    if (s.next < this.t) s.next = this.t + half;
    if (s.next - half > this.t) return;
    // a grain read faster reaches further ahead in the input; it can only go as far as has been heard
    const reach = voiced ? Math.min(formant, (this.latency - 2) / half - 1) : 1;
    const want = s.next - this.latency;
    // start each grain a whole number of cycles after the last, so that neighbouring grains line up
    // (with nothing to change there is nothing to line up: the grains then rebuild the input exactly)
    let centre = want;
    if (voiced && (Math.abs(ratio - 1) > 1e-3 || reach !== 1)) {
      const c = s.lastIn + Math.round((want - s.lastIn) / P) * P;
      if (Math.abs(c - want) <= P && c + half * reach < this.t - 1) centre = c;
    }
    s.lastIn = centre;
    const step = voiced ? P / ratio : half;
    const norm = step / half; // grains closer together overlap more, so each is turned down to match
    const { inL, inR, outL, outR } = this;
    const n = Math.floor(half), at = Math.round(s.next);
    for (let j = -n; j <= n; j++) {
      if (at + j < this.t) continue; // that moment has already gone out
      const w = (0.5 + 0.5 * Math.cos((Math.PI * j) / half)) * norm;
      const pos = centre + j * reach;
      const ip = Math.floor(pos), f = pos - ip;
      const a = ip & MASK, b = (ip + 1) & MASK;
      const o = (at + j) & MASK;
      outL[o] += (inL[a] + (inL[b] - inL[a]) * f) * w * gl;
      outR[o] += (inR[a] + (inR[b] - inR[a]) * f) * w * gr;
    }
    s.next += step;
  }

  /** Read out what the streams have built for this sample, and move on. */
  read(out: Float32Array): void {
    const i = this.t & MASK;
    out[0] = this.outL[i]; out[1] = this.outR[i];
    this.outL[i] = 0; this.outR[i] = 0;
    this.t++;
  }

  /** The pitch being sung as a MIDI note (fractional), or -1. */
  get note(): number {
    const P = this.follower.period;
    return P > 0 ? 69 + 12 * Math.log2(this.sr / P / 440) : -1;
  }
}

/** Something that needs to know the song's key. The engine tells it whenever the project changes. */
export interface Keyed {
  setKey(root: number, type: number): void;
}

/** Nearest note of a scale to a (fractional) pitch. */
function nearest(note: number, root: number, iv: number[]): number {
  const base = Math.floor(note);
  let best = Math.round(note), dist = Infinity;
  for (let c = base - 6; c <= base + 7; c++) {
    if (!iv.includes((((c - root) % 12) + 12) % 12)) continue;
    const d = Math.abs(c - note);
    if (d < dist) { dist = d; best = c; }
  }
  return best;
}

/** The note `degrees` scale steps above (or below) an in-scale note. */
function stepsFrom(note: number, degrees: number, root: number, iv: number[]): number {
  let n = note, left = Math.abs(degrees);
  const dir = degrees < 0 ? -1 : 1;
  while (left > 0) {
    n += dir;
    if (iv.includes((((n - root) % 12) + 12) % 12)) left--;
    if (n < 0 || n > 127) break;
  }
  return n;
}

const CHROMATIC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** Shared by the three pitch effects: the grain machine, the key, and a note to hold on to. */
abstract class VocalInsert implements Insert, Keyed {
  reduction = 0;
  protected v: Voicer;
  protected root = 0;
  protected iv: number[] = SCALES[1].iv;
  protected held = -1;
  protected frame = new Float32Array(2);

  constructor(protected sr: number) {
    this.v = new Voicer(sr);
  }

  setKey(root: number, type: number): void {
    this.root = root;
    this.iv = (SCALES[type] ?? SCALES[0]).iv;
  }

  /**
   * The note the voice is aiming at. A singer wobbles around a note, so the choice is held until the pitch has
   * clearly moved on to another: otherwise the correction would flicker between two notes on every wobble.
   */
  protected target(note: number, chromatic: boolean): number {
    const iv = chromatic ? CHROMATIC : this.iv;
    const near = nearest(note, this.root, iv);
    if (this.held < 0 || Math.abs(note - this.held) > Math.abs(note - near) + 0.2) this.held = near;
    return this.held;
  }

  abstract process(L: Float32Array, R: Float32Array, n: number, p: number[]): void;
}

/** Pitch correction. Knobs: speed (how fast a note is pulled into tune), amount, scale (the song's key or any semitone), formant. */
export class Tune extends VocalInsert {
  private s = new Stream();
  private ratio = 1;

  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const v = this.v, s = this.s, out = this.frame;
    // speed: 0 takes 300 ms to arrive (a gentle nudge), 127 is instant (the hard, stepped sound)
    const tau = p[0] >= 126.5 ? 0 : 0.3 * Math.pow(0.004 / 0.3, p[0] / 127);
    const k = tau ? 1 - Math.exp(-1 / (tau * this.sr)) : 1;
    const amount = p[1] / 127;
    const chromatic = p[2] >= 64;
    const formant = Math.pow(2, ((p[3] - 64) / 64) * 0.5); // half an octave either way
    for (let i = 0; i < n; i++) {
      v.write(L[i], R[i]);
      const note = v.note;
      let want = 1;
      if (note >= 0) want = Math.pow(2, ((this.target(note, chromatic) - note) * amount) / 12);
      else this.held = -1;
      this.ratio += (want - this.ratio) * k;
      v.run(s, this.ratio, formant, 1, 1);
      v.read(out);
      L[i] = out[0]; R[i] = out[1];
    }
  }
}

/** Harmonies and doubling. Knobs: voice 1 and voice 2 (scale steps above or below, middle = off), double (two detuned copies, left and right), mix. */
export class Harmony extends VocalInsert {
  private a = new Stream();
  private b = new Stream();
  private dl = new Stream();
  private dr = new Stream();

  private static steps = (v: number) => Math.round(((v - 64) / 64) * 7);

  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const v = this.v, out = this.frame;
    const s1 = Harmony.steps(p[0]), s2 = Harmony.steps(p[1]);
    const dbl = p[2] / 127, mix = p[3] / 127;
    const up = Math.pow(2, (9 * dbl) / 1200), down = 1 / up; // up to 9 cents either side
    for (let i = 0; i < n; i++) {
      v.write(L[i], R[i]);
      const note = v.note;
      let r1 = 1, r2 = 1;
      if (note >= 0) {
        const on = this.target(note, false);
        if (s1) r1 = Math.pow(2, (stepsFrom(on, s1, this.root, this.iv) - note) / 12);
        if (s2) r2 = Math.pow(2, (stepsFrom(on, s2, this.root, this.iv) - note) / 12);
      } else this.held = -1;
      // a consonant has no pitch to harmonise; let it through once rather than three times
      const g = note >= 0 ? 0.7 : 0;
      if (s1) v.run(this.a, r1, 1, g, g * 0.6);
      if (s2) v.run(this.b, r2, 1, g * 0.6, g);
      if (dbl > 0.01) { v.run(this.dl, up, 1, 0.6, 0); v.run(this.dr, down, 1, 0, 0.6); }
      const dryL = v.dry(false), dryR = v.dry(true);
      v.read(out);
      L[i] = dryL + out[0] * mix;
      R[i] = dryR + out[1] * mix;
    }
  }
}

/** Formant and pitch shift. Knobs: formant (the size of the voice), pitch (semitones), mix. */
export class Formant extends VocalInsert {
  private s = new Stream();

  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const v = this.v, out = this.frame;
    const formant = Math.pow(2, (p[0] - 64) / 64); // an octave either way
    const ratio = Math.pow(2, Math.round(((p[1] - 64) / 64) * 12) / 12);
    const mix = p[2] / 127;
    for (let i = 0; i < n; i++) {
      v.write(L[i], R[i]);
      v.run(this.s, ratio, formant, 1, 1);
      const dryL = v.dry(false), dryR = v.dry(true);
      v.read(out);
      L[i] = dryL + (out[0] - dryL) * mix;
      R[i] = dryR + (out[1] - dryR) * mix;
    }
  }
}

/** A plain compressor for a single track. Knobs: threshold, ratio, attack, makeup. */
export class TrackComp implements Insert {
  reduction = 0;
  private env = 0;
  constructor(private sr: number) {}

  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const thresh = -(p[0] / 127) * 48;
    const slope = 1 - 1 / (1 + (p[1] / 127) * 19);
    const atk = Math.exp(-1 / ((0.0005 + (p[2] / 127) * 0.06) * this.sr));
    const rel = Math.exp(-1 / (0.12 * this.sr));
    const makeup = Math.pow(10, ((p[3] / 127) * 24) / 20);
    const knee = 6, half = 3;
    let env = this.env, peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      const lvl = a > b ? a : b;
      let gr = 0;
      if (lvl > 1e-5) {
        const over = 8.685889638 * Math.log(lvl) - thresh;
        if (over > half) gr = over * slope;
        else if (over > -half) gr = (slope * (over + half) * (over + half)) / (2 * knee);
      }
      env = gr > env ? gr + (env - gr) * atk : gr + (env - gr) * rel;
      if (env > peak) peak = env;
      const g = Math.exp(-0.115129255 * env) * makeup;
      L[i] *= g;
      R[i] *= g;
    }
    this.env = env < 1e-9 ? 0 : env;
    this.reduction = peak;
  }
}

/**
 * De-esser: turns down the top of the sound only while it is hissing ("s", "sh", "t"), and leaves it alone the
 * rest of the time. Knobs: frequency (where the hiss is), threshold, amount.
 */
export class DeEsser implements Insert {
  reduction = 0;
  private env = 0;
  // listening: a steep high-pass per channel that hears only the hiss
  private x1 = [0, 0]; private x2 = [0, 0]; private y1 = [0, 0]; private y2 = [0, 0];
  // acting: a gentle split much lower down, whose top half is what gets turned down. A gentle filter barely
  // shifts the phase up where the hiss is, so taking its output away really does take the hiss away
  // (subtracting a steep filter's output mostly just rotates it).
  private lp = [0, 0];
  constructor(private sr: number) {}

  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const f = Math.min(this.sr * 0.42, 3000 * Math.pow(4, p[0] / 127));
    const w = (2 * Math.PI * f) / this.sr, cs = Math.cos(w), al = Math.sin(w) / (2 * 0.707);
    const a0 = 1 + al, b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, a1 = (-2 * cs) / a0, a2 = (1 - al) / a0;
    const k = 1 - Math.exp((-2 * Math.PI * (f / 3)) / this.sr);
    const thresh = Math.pow(10, -((p[1] / 127) * 48) / 20);
    const amount = p[2] / 127;
    const atk = Math.exp(-1 / (0.001 * this.sr)), rel = Math.exp(-1 / (0.06 * this.sr));
    const { x1, x2, y1, y2, lp } = this;
    let env = this.env, peak = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const hl = b0 * l + b1 * x1[0] + b0 * x2[0] - a1 * y1[0] - a2 * y2[0];
      x2[0] = x1[0]; x1[0] = l; y2[0] = y1[0]; y1[0] = hl;
      const hr = b0 * r + b1 * x1[1] + b0 * x2[1] - a1 * y1[1] - a2 * y2[1];
      x2[1] = x1[1]; x1[1] = r; y2[1] = y1[1]; y1[1] = hr;
      const lvl = Math.max(Math.abs(hl), Math.abs(hr));
      env = lvl > env ? lvl + (env - lvl) * atk : lvl + (env - lvl) * rel;
      // how far the hiss is over the line decides how much of the top is taken away
      const cut = env > thresh ? amount * (1 - thresh / env) : 0;
      if (cut > peak) peak = cut;
      lp[0] += (l - lp[0]) * k;
      lp[1] += (r - lp[1]) * k;
      L[i] = l - (l - lp[0]) * cut;
      R[i] = r - (r - lp[1]) * cut;
    }
    this.env = env < 1e-9 ? 0 : env;
    for (let c = 0; c < 2; c++) {
      if (Math.abs(y1[c]) < 1e-20) { y1[c] = 0; y2[c] = 0; }
      if (Math.abs(lp[c]) < 1e-20) lp[c] = 0;
    }
    this.reduction = peak * 12;
  }
}

/** How late the pitch effects are, in samples, at a sample rate. */
export const vocalLatency = (sr: number) => Math.ceil((sr / LOWEST_HZ) * WAIT);
