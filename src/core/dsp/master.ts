// The mastering chain: what goes on the whole mix last of all to make it sound
// finished. A three-band EQ for tone, a three-band compressor for glue, a
// stereo width control, and a limiter that sets how loud it is and makes sure
// nothing goes over.

import { LoudnessMeter, SILENT } from '../loudness';

/** The settings, as the engine reads them from the project (see `Mastering` in types.ts). */
export interface MasterSettings {
  low: number; // EQ gains, 64 = flat
  mid: number;
  high: number;
  glue: number; // 0 = no compression .. 127 = heavy
  width: number; // 64 = as mixed, 0 = mono, 127 = twice as wide
  gain: number; // drive into the limiter, 64 = none
}

/** The loudest a mastered sample is allowed to be: -1 dBFS, which leaves room for lossy encoders. */
export const CEILING = Math.pow(10, -1 / 20);
const LOOKAHEAD_MS = 4;
/** Knob to decibels. */
export const eqDb = (v: number) => ((v - 64) / 64) * 12;
export const driveDb = (v: number) => ((v - 64) / 64) * 24;

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = Math.abs(y) < 1e-25 ? 0 : y;
    return this.y1;
  }
  set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  shelf(sr: number, f: number, db: number, high: boolean): void {
    const A = Math.pow(10, db / 40), w = (2 * Math.PI * f) / sr, cs = Math.cos(w), al = (Math.sin(w) / 2) * Math.SQRT2, sq = 2 * Math.sqrt(A) * al;
    if (high) this.set(A * (A + 1 + (A - 1) * cs + sq), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - sq), A + 1 - (A - 1) * cs + sq, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - sq);
    else this.set(A * (A + 1 - (A - 1) * cs + sq), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - sq), A + 1 + (A - 1) * cs + sq, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - sq);
  }
  peak(sr: number, f: number, db: number, q: number): void {
    const A = Math.pow(10, db / 40), w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), cs = Math.cos(w);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  /** Second-order Butterworth low- or high-pass; two in a row make a Linkwitz-Riley crossover. */
  cross(sr: number, f: number, high: boolean): void {
    const w = (2 * Math.PI * f) / sr, cs = Math.cos(w), al = Math.sin(w) / Math.SQRT2;
    if (high) this.set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
    else this.set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
}

/** Splits one channel into lows, mids and highs that add back up to the original (but for a shift in phase). */
class Split {
  private l1 = new Biquad(); private l2 = new Biquad(); private h1 = new Biquad(); private h2 = new Biquad();
  private ml1 = new Biquad(); private ml2 = new Biquad(); private mh1 = new Biquad(); private mh2 = new Biquad();
  // the lows skip the second crossover, so they are passed through its phase shift to stay in step with the rest
  private al1 = new Biquad(); private al2 = new Biquad(); private ah1 = new Biquad(); private ah2 = new Biquad();
  low = 0; mid = 0; high = 0;
  constructor(sr: number, f1: number, f2: number) {
    for (const b of [this.l1, this.l2]) b.cross(sr, f1, false);
    for (const b of [this.h1, this.h2]) b.cross(sr, f1, true);
    for (const b of [this.ml1, this.ml2, this.al1, this.al2]) b.cross(sr, f2, false);
    for (const b of [this.mh1, this.mh2, this.ah1, this.ah2]) b.cross(sr, f2, true);
  }
  run(x: number): void {
    const lo = this.l2.run(this.l1.run(x)), rest = this.h2.run(this.h1.run(x));
    this.low = this.al2.run(this.al1.run(lo)) + this.ah2.run(this.ah1.run(lo));
    this.mid = this.ml2.run(this.ml1.run(rest));
    this.high = this.mh2.run(this.mh1.run(rest));
  }
}

const BANDS = [
  { atk: 0.03, rel: 0.25, thresh: -22 }, // lows: slow, so the kick keeps its punch
  { atk: 0.012, rel: 0.15, thresh: -24 },
  { atk: 0.004, rel: 0.09, thresh: -28 }, // highs: quick, to catch hats and esses
];

export class MasterChain {
  /** Gain reduction of the three bands and then the limiter, in dB, for the meters. */
  readonly reduction = new Float32Array(4);
  /** Loudness going in and coming out (short-term LUFS), for comparing before and after at the same volume. */
  readonly before: LoudnessMeter;
  readonly after: LoudnessMeter;
  private eq: Biquad[][] = [];
  private split: Split[];
  private env = new Float32Array(3);
  private last = { low: -1, mid: -1, high: -1 };
  // limiter: the audio is held back a few ms so the gain can come down before a peak arrives, not after
  private look: number;
  private dl: Float32Array;
  private dr: Float32Array;
  private w = 0;
  private limit = 1;
  private hold = 0;
  private wd = -1; // not set yet: the first block takes the width as it is, with nothing to ease from
  private match = 1;
  private scratchL = new Float32Array(128);
  private scratchR = new Float32Array(128);

  constructor(private sr: number) {
    for (let c = 0; c < 2; c++) this.eq.push([new Biquad(), new Biquad(), new Biquad()]);
    this.split = [new Split(sr, 160, 3000), new Split(sr, 160, 3000)];
    this.look = Math.max(8, Math.round((LOOKAHEAD_MS / 1000) * sr));
    this.dl = new Float32Array(this.look);
    this.dr = new Float32Array(this.look);
    this.before = new LoudnessMeter(sr);
    this.after = new LoudnessMeter(sr);
  }

  /** How late the chain's output is, in frames. */
  get latency(): number {
    return this.look;
  }

  /**
   * Master a block in place. With `compare`, what comes out is the mix as it went in, turned up or down to be as
   * loud as the mastered version: a fair way to hear what the chain is doing, since louder always sounds better.
   */
  process(L: Float32Array, R: Float32Array, n: number, s: MasterSettings, compare = false): void {
    if (this.scratchL.length < n) { this.scratchL = new Float32Array(n); this.scratchR = new Float32Array(n); }
    const inL = this.scratchL, inR = this.scratchR;
    inL.set(L.subarray(0, n)); inR.set(R.subarray(0, n));
    this.before.process(L, R, n);

    if (s.low !== this.last.low || s.mid !== this.last.mid || s.high !== this.last.high) {
      this.last = { low: s.low, mid: s.mid, high: s.high };
      for (const ch of this.eq) { ch[0].shelf(this.sr, 110, eqDb(s.low), false); ch[1].peak(this.sr, 1400, eqDb(s.mid), 0.7); ch[2].shelf(this.sr, 8000, eqDb(s.high), true); }
    }
    const glue = s.glue / 127;
    const ratio = 1 + glue * 3; // up to 4:1
    const slope = 1 - 1 / ratio;
    const makeup = Math.pow(10, (glue * 4) / 20); // gives back roughly what the compression takes on a full mix
    const width = s.width <= 64 ? s.width / 64 : 1 + (s.width - 64) / 63;
    const drive = Math.pow(10, driveDb(s.gain) / 20);
    const atk: number[] = [], rel: number[] = [], thr: number[] = [];
    for (let b = 0; b < 3; b++) {
      atk.push(Math.exp(-1 / (BANDS[b].atk * this.sr)));
      rel.push(Math.exp(-1 / (BANDS[b].rel * this.sr)));
      thr.push(BANDS[b].thresh - glue * 8);
    }
    const env = this.env, red = this.reduction;
    red.fill(0);
    const relLim = Math.exp(-1 / (0.08 * this.sr));
    const { dl, dr, look } = this;
    const [sl, sr] = this.split;
    if (this.wd < 0) this.wd = width;
    const dw = (width - this.wd) / n;
    let wd = this.wd, limit = this.limit, hold = this.hold, w = this.w;

    for (let i = 0; i < n; i++) {
      // tone
      let l = this.eq[0][2].run(this.eq[0][1].run(this.eq[0][0].run(L[i])));
      let r = this.eq[1][2].run(this.eq[1][1].run(this.eq[1][0].run(R[i])));
      // glue: each band is turned down on its own, so a loud kick doesn't pull the cymbals down with it
      sl.run(l); sr.run(r);
      l = 0; r = 0;
      for (let b = 0; b < 3; b++) {
        const bl = b === 0 ? sl.low : b === 1 ? sl.mid : sl.high, br = b === 0 ? sr.low : b === 1 ? sr.mid : sr.high;
        const a = bl < 0 ? -bl : bl, c = br < 0 ? -br : br;
        const lvl = a > c ? a : c;
        let gr = 0;
        if (glue > 0 && lvl > 1e-5) {
          const over = 8.685889638 * Math.log(lvl) - thr[b];
          if (over > 0) gr = over * slope;
        }
        env[b] = gr > env[b] ? gr + (env[b] - gr) * atk[b] : gr + (env[b] - gr) * rel[b];
        if (env[b] > red[b]) red[b] = env[b];
        const g = Math.exp(-0.115129255 * env[b]);
        l += bl * g; r += br * g;
      }
      // width: turn the difference between left and right up or down
      wd += dw;
      const m = (l + r) * 0.5, sd = (l - r) * 0.5 * wd;
      l = (m + sd) * makeup * drive;
      r = (m - sd) * makeup * drive;
      // limiter: look at what is coming, and have the gain down in time for it
      const pk = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      const need = pk > CEILING ? CEILING / pk : 1;
      if (need < limit) { limit += (need - limit) * 0.5; if (need < limit) limit = Math.min(limit, need + (limit - need) * 0.6); hold = look; }
      else if (hold > 0) hold--;
      else limit = need + (limit - need) * relLim;
      const ol = dl[w], or = dr[w];
      dl[w] = l; dr[w] = r;
      if (++w === look) w = 0;
      let yl = ol * limit, yr = or * limit;
      // whatever the smoothing lets through is caught here: nothing leaves above the ceiling
      if (yl > CEILING) yl = CEILING; else if (yl < -CEILING) yl = -CEILING;
      if (yr > CEILING) yr = CEILING; else if (yr < -CEILING) yr = -CEILING;
      L[i] = yl; R[i] = yr;
      const lr = -8.685889638 * Math.log(limit);
      if (lr > red[3]) red[3] = lr;
    }
    for (let b = 0; b < 3; b++) if (env[b] < 1e-9) env[b] = 0;
    this.wd = width; this.limit = limit; this.hold = hold; this.w = w;
    this.after.process(L, R, n);

    // before/after: the untouched mix, matched to how loud the mastered one is
    const a = this.after.shortTerm, b = this.before.shortTerm;
    const want = compare && a > SILENT && b > SILENT ? Math.pow(10, Math.max(-24, Math.min(24, a - b)) / 20) : 1;
    if (compare || Math.abs(this.match - 1) > 1e-3) {
      const step = ((compare ? want : 1) - this.match) / n;
      let g = this.match;
      if (compare) for (let i = 0; i < n; i++) { g += step; L[i] = Math.max(-1, Math.min(1, inL[i] * g)); R[i] = Math.max(-1, Math.min(1, inR[i] * g)); }
      this.match = compare ? want : 1;
    }
  }
}
