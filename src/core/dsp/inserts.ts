// Per-track insert effects. Each one processes a stereo block in place and
// takes its settings as four knob values (0..127).

// The order is part of the share-link format: new effects go on the end.
export const INSERT_TYPES = ['eq', 'drive', 'chorus', 'crush', 'duck', 'tune', 'harm', 'formant', 'comp', 'deess'] as const;
export type InsertType = (typeof INSERT_TYPES)[number];

import { DeEsser, Formant, Harmony, TrackComp, Tune } from './vocal';

export interface InsertInfo {
  name: string;
  knobs: { label: string; def: number }[];
}

/** Names, knob labels and defaults, in the order the knobs are stored. */
export const INSERTS: Record<InsertType, InsertInfo> = {
  eq: { name: 'EQ', knobs: [{ label: 'Low', def: 64 }, { label: 'Mid', def: 64 }, { label: 'High', def: 64 }, { label: 'Mid freq', def: 64 }] },
  drive: { name: 'Drive', knobs: [{ label: 'Drive', def: 50 }, { label: 'Tone', def: 100 }, { label: 'Mix', def: 127 }, { label: 'Shape', def: 0 }] },
  chorus: { name: 'Chorus', knobs: [{ label: 'Rate', def: 40 }, { label: 'Depth', def: 70 }, { label: 'Mix', def: 64 }, { label: 'Width', def: 127 }] },
  crush: { name: 'Crusher', knobs: [{ label: 'Bits', def: 70 }, { label: 'Rate', def: 40 }, { label: 'Mix', def: 127 }, { label: 'Jitter', def: 0 }] },
  duck: { name: 'Sidechain', knobs: [{ label: 'Source', def: 1 }, { label: 'Thresh', def: 50 }, { label: 'Amount', def: 90 }, { label: 'Release', def: 50 }] },
  tune: { name: 'Tune', knobs: [{ label: 'Speed', def: 90 }, { label: 'Amount', def: 127 }, { label: 'Scale', def: 0 }, { label: 'Formant', def: 64 }] },
  harm: { name: 'Harmony', knobs: [{ label: 'Voice 1', def: 82 }, { label: 'Voice 2', def: 64 }, { label: 'Double', def: 0 }, { label: 'Mix', def: 90 }] },
  formant: { name: 'Formant', knobs: [{ label: 'Formant', def: 64 }, { label: 'Pitch', def: 64 }, { label: 'Mix', def: 127 }, { label: '—', def: 0 }] },
  comp: { name: 'Compressor', knobs: [{ label: 'Thresh', def: 50 }, { label: 'Ratio', def: 30 }, { label: 'Attack', def: 20 }, { label: 'Makeup', def: 30 }] },
  deess: { name: 'De-esser', knobs: [{ label: 'Freq', def: 64 }, { label: 'Thresh', def: 70 }, { label: 'Amount', def: 90 }, { label: '—', def: 0 }] },
};

/** The effects made for a voice, which the rack lists together. */
export const VOCAL_INSERTS: InsertType[] = ['tune', 'harm', 'formant', 'comp', 'deess'];

export const DRIVE_SHAPES = ['Soft', 'Hard', 'Fold'];

export interface Insert {
  /** `key` is the signal a sidechain listens to; only the ducker uses it. */
  process(L: Float32Array, R: Float32Array, n: number, p: number[], keyL?: Float32Array, keyR?: Float32Array): void;
  /** Gain reduction in dB for meters; 0 for effects that don't compress. */
  reduction: number;
  /** Effects that work in the song's key are told what it is. */
  setKey?(root: number, type: number): void;
}

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1l = 0; private x2l = 0; private y1l = 0; private y2l = 0;
  private x1r = 0; private x2r = 0; private y1r = 0; private y2r = 0;

  /** RBJ cookbook shelves and peak. `gainDb` 0 leaves the signal untouched. */
  set(type: 'low' | 'peak' | 'high', freq: number, gainDb: number, q: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
    const cs = Math.cos(w), sn = Math.sin(w);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (type === 'peak') {
      const alpha = sn / (2 * q);
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    } else {
      const alpha = (sn / 2) * Math.SQRT2;
      const k = 2 * Math.sqrt(A) * alpha;
      if (type === 'low') {
        b0 = A * (A + 1 - (A - 1) * cs + k); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - k);
        a0 = A + 1 + (A - 1) * cs + k; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - k;
      } else {
        b0 = A * (A + 1 + (A - 1) * cs + k); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - k);
        a0 = A + 1 - (A - 1) * cs + k; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - k;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  run(L: Float32Array, R: Float32Array, n: number): void {
    const { b0, b1, b2, a1, a2 } = this;
    let x1 = this.x1l, x2 = this.x2l, y1 = this.y1l, y2 = this.y2l;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      L[i] = y;
    }
    this.x1l = x1; this.x2l = x2; this.y1l = Math.abs(y1) < 1e-20 ? 0 : y1; this.y2l = Math.abs(y2) < 1e-20 ? 0 : y2;
    x1 = this.x1r; x2 = this.x2r; y1 = this.y1r; y2 = this.y2r;
    for (let i = 0; i < n; i++) {
      const x = R[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      R[i] = y;
    }
    this.x1r = x1; this.x2r = x2; this.y1r = Math.abs(y1) < 1e-20 ? 0 : y1; this.y2r = Math.abs(y2) < 1e-20 ? 0 : y2;
  }
}

/** Three bands: low shelf at 180 Hz, a sweepable mid bell, high shelf at 5 kHz. Each ±15 dB. */
class Eq implements Insert {
  reduction = 0;
  private low = new Biquad(); private mid = new Biquad(); private high = new Biquad();
  private last = [-1, -1, -1, -1];
  constructor(private sr: number) {}
  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const l = this.last;
    if (p[0] !== l[0] || p[1] !== l[1] || p[2] !== l[2] || p[3] !== l[3]) {
      const db = (v: number) => ((v - 64) / 63) * 15;
      this.low.set('low', 180, db(p[0]), 0.7, this.sr);
      this.mid.set('peak', 200 * Math.pow(30, p[3] / 127), db(p[1]), 0.9, this.sr);
      this.high.set('high', 5000, db(p[2]), 0.7, this.sr);
      l[0] = p[0]; l[1] = p[1]; l[2] = p[2]; l[3] = p[3];
    }
    if (p[0] !== 64) this.low.run(L, R, n);
    if (p[1] !== 64) this.mid.run(L, R, n);
    if (p[2] !== 64) this.high.run(L, R, n);
  }
}

/** Saturation into a tone filter: soft (tanh), hard clip or wavefolding. */
class Drive implements Insert {
  reduction = 0;
  private lpL = 0; private lpR = 0;
  constructor(private sr: number) {}
  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const pre = Math.pow(10, ((p[0] / 127) * 36) / 20);
    const post = 1 / Math.pow(pre, 0.55); // keep the loudness roughly where it was
    const coef = 1 - Math.exp((-2 * Math.PI * 600 * Math.pow(30, p[1] / 127)) / this.sr);
    const wet = p[2] / 127, dry = 1 - wet;
    const shape = p[3] < 43 ? 0 : p[3] < 86 ? 1 : 2;
    let lpL = this.lpL, lpR = this.lpR;
    for (let i = 0; i < n; i++) {
      let a = L[i] * pre, b = R[i] * pre;
      if (shape === 0) { a = Math.tanh(a); b = Math.tanh(b); }
      else if (shape === 1) { a = a > 1 ? 1 : a < -1 ? -1 : a; b = b > 1 ? 1 : b < -1 ? -1 : b; }
      else { a = Math.sin(a * 1.5707963); b = Math.sin(b * 1.5707963); }
      lpL += (a - lpL) * coef;
      lpR += (b - lpR) * coef;
      L[i] = L[i] * dry + lpL * post * wet;
      R[i] = R[i] * dry + lpR * post * wet;
    }
    this.lpL = Math.abs(lpL) < 1e-20 ? 0 : lpL;
    this.lpR = Math.abs(lpR) < 1e-20 ? 0 : lpR;
  }
}

/** Two modulated delay taps a quarter-cycle apart, one per side. */
class Chorus implements Insert {
  reduction = 0;
  private bl: Float32Array; private br: Float32Array;
  private w = 0; private ph = 0;
  private size: number;
  constructor(private sr: number) {
    this.size = 1 << Math.ceil(Math.log2(sr * 0.05));
    this.bl = new Float32Array(this.size);
    this.br = new Float32Array(this.size);
  }
  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const sr = this.sr, mask = this.size - 1, bl = this.bl, br = this.br;
    const inc = (0.08 * Math.pow(100, p[0] / 127)) / sr;
    const base = 0.012 * sr, depth = (p[1] / 127) * 0.008 * sr;
    const wet = (p[2] / 127) * 0.9, width = p[3] / 127;
    let w = this.w, ph = this.ph;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      bl[w] = xl; br[w] = xr;
      const dl = base + depth * Math.sin(2 * Math.PI * ph);
      const dr = base + depth * Math.sin(2 * Math.PI * (ph + 0.25 * width));
      let rp = w - dl; let i0 = Math.floor(rp); let fr = rp - i0;
      const a = bl[i0 & mask] + (bl[(i0 + 1) & mask] - bl[i0 & mask]) * fr;
      rp = w - dr; i0 = Math.floor(rp); fr = rp - i0;
      const b = br[i0 & mask] + (br[(i0 + 1) & mask] - br[i0 & mask]) * fr;
      L[i] = xl + a * wet;
      R[i] = xr + b * wet;
      w = (w + 1) & mask;
      ph += inc; if (ph >= 1) ph -= 1;
    }
    this.w = w; this.ph = ph;
  }
}

/** Fewer bits and a lower sample rate, the sound of old samplers. */
class Crusher implements Insert {
  reduction = 0;
  private holdL = 0; private holdR = 0; private count = 0; private seed = 7;
  constructor(_sr: number) {}
  process(L: Float32Array, R: Float32Array, n: number, p: number[]): void {
    const levels = Math.pow(2, 16 - (p[0] / 127) * 14) / 2;
    const period = 1 + (p[1] / 127) * 39;
    const wet = p[2] / 127, dry = 1 - wet;
    const jitter = (p[3] / 127) * 0.9;
    let hl = this.holdL, hr = this.holdR, count = this.count, seed = this.seed;
    for (let i = 0; i < n; i++) {
      if (--count <= 0) {
        hl = Math.round(L[i] * levels) / levels;
        hr = Math.round(R[i] * levels) / levels;
        count += period;
        if (jitter) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
          count += (seed / 2147483648) * jitter * period;
        }
      }
      L[i] = L[i] * dry + hl * wet;
      R[i] = R[i] * dry + hr * wet;
    }
    this.holdL = hl; this.holdR = hr; this.count = count; this.seed = seed;
  }
}

/** Sidechain compressor: turns this track down whenever the key signal (another track, or itself) is loud. */
class Ducker implements Insert {
  reduction = 0;
  private env = 0;
  constructor(private sr: number) {}
  process(L: Float32Array, R: Float32Array, n: number, p: number[], keyL?: Float32Array, keyR?: Float32Array): void {
    const kl = keyL ?? L, kr = keyR ?? R;
    const thresh = -((p[1] / 127) * 48);
    const slope = (p[2] / 127) * 0.97; // 1 - 1/ratio
    const atk = Math.exp(-1 / (0.002 * this.sr));
    const rel = Math.exp(-1 / ((0.02 + (p[3] / 127) * 0.6) * this.sr));
    let env = this.env, peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(kl[i]), b = Math.abs(kr[i]);
      const lvl = a > b ? a : b;
      let gr = 0;
      if (lvl > 1e-5) {
        const over = 8.685889638 * Math.log(lvl) - thresh;
        if (over > 0) gr = over * slope;
      }
      env = gr > env ? gr + (env - gr) * atk : gr + (env - gr) * rel;
      if (env > peak) peak = env;
      const g = Math.exp(-0.115129255 * env);
      L[i] *= g;
      R[i] *= g;
    }
    this.env = env < 1e-9 ? 0 : env;
    this.reduction = peak;
  }
}

export function createInsert(type: InsertType, sampleRate: number): Insert {
  switch (type) {
    case 'eq': return new Eq(sampleRate);
    case 'drive': return new Drive(sampleRate);
    case 'chorus': return new Chorus(sampleRate);
    case 'crush': return new Crusher(sampleRate);
    case 'duck': return new Ducker(sampleRate);
    case 'tune': return new Tune(sampleRate);
    case 'harm': return new Harmony(sampleRate);
    case 'formant': return new Formant(sampleRate);
    case 'comp': return new TrackComp(sampleRate);
    case 'deess': return new DeEsser(sampleRate);
  }
}
