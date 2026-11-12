// Effects: DJ-style filter, ping-pong delay, Freeverb-style reverb, compressor.

/** One knob: below zero sweeps a low-pass down, above zero sweeps a high-pass up. */
export class DjFilter {
  private l1 = 0; private l2 = 0; private r1 = 0; private r2 = 0;
  private cur = 0;
  private wasOn = false;

  constructor(private sampleRate: number) {}

  /** amount -1..1, reso 0..1. Processes in place. */
  process(L: Float32Array, R: Float32Array, n: number, amount: number, reso: number): void {
    this.cur += (amount - this.cur) * 0.25; // smooth knob moves across blocks
    const a = this.cur;
    if (Math.abs(a) < 0.012) {
      if (this.wasOn) { this.l1 = this.l2 = this.r1 = this.r2 = 0; this.wasOn = false; }
      return;
    }
    this.wasOn = true;
    const lp = a < 0;
    const fc = lp ? 20000 * Math.pow(80 / 20000, -a) : 20 * Math.pow(8000 / 20, a);
    const g = Math.tan((Math.PI * Math.min(fc, this.sampleRate * 0.45)) / this.sampleRate);
    const k = 1.6 - 1.45 * reso;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
    for (let i = 0; i < n; i++) {
      let x = L[i];
      let v3 = x - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3;
      l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
      L[i] = lp ? v2 : x - k * v1 - v2;
      x = R[i];
      v3 = x - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3;
      r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
      R[i] = lp ? v2 : x - k * v1 - v2;
    }
    if (Math.abs(l1) < 1e-20) l1 = 0;
    if (Math.abs(r1) < 1e-20) r1 = 0;
    if (Math.abs(l2) < 1e-20) l2 = 0;
    if (Math.abs(r2) < 1e-20) r2 = 0;
    this.l1 = l1; this.l2 = l2; this.r1 = r1; this.r2 = r2;
  }
}

export class PingPongDelay {
  private bl: Float32Array;
  private br: Float32Array;
  private w = 0;
  private time = 0; // smoothed delay time in frames
  private lpL = 0;
  private lpR = 0;
  private size: number;

  constructor(private sampleRate: number) {
    this.size = Math.ceil(sampleRate * 2.4);
    this.bl = new Float32Array(this.size);
    this.br = new Float32Array(this.size);
  }

  /** Mono-summed input in `inp`, wet signal is added to outL/outR. */
  process(inp: Float32Array, outL: Float32Array, outR: Float32Array, n: number, frames: number, fb: number, level: number): void {
    const size = this.size, bl = this.bl, br = this.br;
    const target = Math.min(Math.max(frames, 16), size - 4);
    if (this.time === 0) this.time = target;
    let w = this.w, time = this.time, lpL = this.lpL, lpR = this.lpR;
    const damp = 1 - Math.exp((-2 * Math.PI * 5200) / this.sampleRate);
    for (let i = 0; i < n; i++) {
      time += (target - time) * 0.0006; // glide like a tape delay when tempo changes
      let rp = w - time; if (rp < 0) rp += size;
      const i0 = rp | 0, fr = rp - i0, i1 = i0 + 1 === size ? 0 : i0 + 1;
      const dl = bl[i0] + (bl[i1] - bl[i0]) * fr;
      const dr = br[i0] + (br[i1] - br[i0]) * fr;
      lpL += (dl - lpL) * damp;
      lpR += (dr - lpR) * damp;
      bl[w] = inp[i] + lpR * fb;
      br[w] = lpL * fb;
      if (++w === size) w = 0;
      outL[i] += dl * level;
      outR[i] += dr * level;
    }
    if (Math.abs(lpL) < 1e-20) lpL = 0;
    if (Math.abs(lpR) < 1e-20) lpR = 0;
    this.w = w; this.time = time; this.lpL = lpL; this.lpR = lpR;
  }
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];
const SPREAD = 23;

class Comb {
  buf: Float32Array; i = 0; store = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
}
class Allpass {
  buf: Float32Array; i = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
}

/** Freeverb topology: 8 parallel damped combs into 4 series all-passes, per channel. */
export class Reverb {
  private cl: Comb[]; private cr: Comb[];
  private al: Allpass[]; private ar: Allpass[];

  constructor(sampleRate: number) {
    const s = sampleRate / 44100;
    this.cl = COMBS.map((n) => new Comb(Math.round(n * s)));
    this.cr = COMBS.map((n) => new Comb(Math.round((n + SPREAD) * s)));
    this.al = ALLPASS.map((n) => new Allpass(Math.round(n * s)));
    this.ar = ALLPASS.map((n) => new Allpass(Math.round((n + SPREAD) * s)));
  }

  process(inp: Float32Array, outL: Float32Array, outR: Float32Array, n: number, size: number, damp: number, level: number): void {
    const fb = 0.7 + size * 0.28;
    const d1 = damp * 0.6, d2 = 1 - d1;
    const wet = level * 0.6;
    for (let i = 0; i < n; i++) {
      const x = inp[i] * 0.03;
      let l = 0, r = 0;
      for (let c = 0; c < 8; c++) {
        let cb = this.cl[c];
        let y = cb.buf[cb.i];
        cb.store = y * d2 + cb.store * d1;
        cb.buf[cb.i] = x + cb.store * fb;
        if (++cb.i === cb.buf.length) cb.i = 0;
        l += y;
        cb = this.cr[c];
        y = cb.buf[cb.i];
        cb.store = y * d2 + cb.store * d1;
        cb.buf[cb.i] = x + cb.store * fb;
        if (++cb.i === cb.buf.length) cb.i = 0;
        r += y;
      }
      for (let a = 0; a < 4; a++) {
        let ap = this.al[a];
        let b = ap.buf[ap.i];
        ap.buf[ap.i] = l + b * 0.5;
        if (++ap.i === ap.buf.length) ap.i = 0;
        l = b - l;
        ap = this.ar[a];
        b = ap.buf[ap.i];
        ap.buf[ap.i] = r + b * 0.5;
        if (++ap.i === ap.buf.length) ap.i = 0;
        r = b - r;
      }
      outL[i] += l * wet;
      outR[i] += r * wet;
    }
    // flush denormals
    for (let c = 0; c < 8; c++) {
      if (Math.abs(this.cl[c].store) < 1e-20) this.cl[c].store = 0;
      if (Math.abs(this.cr[c].store) < 1e-20) this.cr[c].store = 0;
    }
  }
}

/** Stereo-linked feed-forward compressor with a soft knee. */
export class Compressor {
  /** Current gain reduction in dB (positive number), for metering. */
  reduction = 0;
  private env = 0; // smoothed gain reduction, dB
  private atk: number;
  private rel: number;

  constructor(sampleRate: number) {
    this.atk = Math.exp(-1 / (0.004 * sampleRate));
    this.rel = Math.exp(-1 / (0.14 * sampleRate));
  }

  process(L: Float32Array, R: Float32Array, n: number, threshDb: number, ratio: number, makeupDb: number): void {
    const knee = 6, half = knee / 2;
    const slope = 1 - 1 / ratio;
    const makeup = Math.pow(10, makeupDb / 20);
    let env = this.env, peak = 0;
    const atk = this.atk, rel = this.rel;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      const lvl = a > b ? a : b;
      let gr = 0;
      if (lvl > 1e-5) {
        const over = 8.685889638 * Math.log(lvl) - threshDb; // 20*log10
        if (over > half) gr = over * slope;
        else if (over > -half) gr = (slope * (over + half) * (over + half)) / (2 * knee);
      }
      env = gr > env ? gr + (env - gr) * atk : gr + (env - gr) * rel;
      if (env > peak) peak = env;
      const g = Math.exp(-0.115129255 * env) * makeup; // 10^(-env/20)
      L[i] *= g;
      R[i] *= g;
    }
    if (env < 1e-9) env = 0;
    this.env = env;
    this.reduction = peak;
  }
}

/** Transparent below 0.7, then eases into the rail instead of clipping hard. */
export function softClip(buf: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    if (x > 0.7) buf[i] = 0.7 + 0.3 * Math.tanh((x - 0.7) / 0.3);
    else if (x < -0.7) buf[i] = -0.7 - 0.3 * Math.tanh((-x - 0.7) / 0.3);
  }
}
