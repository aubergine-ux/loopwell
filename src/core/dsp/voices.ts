// Sample and synth voices. Both render additively into a stereo block.

import { WT_FRAMES, WT_SIZE, mipFor, type Wavetable } from './wavetable';

export interface SampleData {
  l: Float32Array;
  r: Float32Array; // same array as l for mono
}

const KILL_FRAMES = 96;
const FADE_IN = 48;
const GRAIN = 2048; // time-stretch grain, in output frames
const TAU = 2 * Math.PI;

export class SampleVoice {
  active = false;
  age = 0;
  private data: SampleData | null = null;
  private pos = 0;
  private from = 0;
  private to = 0;
  private dir = 1;
  private rate = 1;
  private gain = 0;
  private env = 1;
  private decay = 1;
  private fade = 1;
  private killing = false;
  private gate = Infinity;
  private played = 0;
  private soft = false; // fade in, for slices that start in the middle of a wave
  // time-stretch: two overlapping grains read the sample at the pitch rate while `pos` crawls along at the stretch speed
  private speed = 0;
  private gpos0 = 0; private gpos1 = 0;
  private gph0 = 0; private gph1 = 0;
  private gon0 = false; private gon1 = false;
  private first = true;

  /**
   * Play `data` between frames `from` and `to`. `rate` is the pitch ratio.
   * `stretch` 1 plays normally (pitch and length move together); any other
   * value makes it that many times longer without changing the pitch.
   */
  start(data: SampleData, rate: number, gain: number, decayCoef: number, age: number,
    from = 0, to = data.l.length, reverse = false, stretch = 1, gate = Infinity): void {
    this.data = data;
    this.from = from;
    this.to = to;
    this.dir = reverse ? -1 : 1;
    this.pos = reverse ? to - 1.001 : from;
    this.rate = rate;
    this.gain = gain;
    this.env = 1;
    this.decay = decayCoef;
    this.fade = 1;
    this.killing = false;
    this.gate = gate;
    this.played = 0;
    this.soft = from > 0 || reverse;
    this.speed = stretch === 1 ? 0 : 1 / stretch;
    this.gpos0 = this.pos; this.gph0 = 0; this.gon0 = true;
    this.gon1 = false; this.gph1 = 0;
    this.first = true;
    this.active = to - from > 2;
    this.age = age;
  }

  /** Fade out over a couple of ms instead of cutting dead. */
  kill(): void {
    this.killing = true;
  }

  get level(): number {
    return this.active ? this.fade * this.env : 0;
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    if (this.speed) { this.renderStretched(outL, outR, from, to); return; }
    const d = this.data!;
    const L = d.l, R = d.r;
    const lo = this.from, hi = this.to - 1;
    const dir = this.dir, step = this.rate * dir;
    let pos = this.pos, env = this.env, fade = this.fade, played = this.played, gate = this.gate;
    const gain = this.gain, decay = this.decay, soft = this.soft;
    let killing = this.killing;
    for (let i = from; i < to; i++) {
      const ip = pos | 0;
      if (ip >= hi || pos < lo) { this.active = false; break; }
      const fr = pos - ip;
      let g = gain * env * fade;
      const tail = dir > 0 ? hi - pos : pos - lo;
      if (tail < 64) g *= tail / 64; // de-click samples that don't end at zero
      if (soft && played < FADE_IN) g *= played / FADE_IN;
      outL[i] += (L[ip] + (L[ip + 1] - L[ip]) * fr) * g;
      outR[i] += (R[ip] + (R[ip + 1] - R[ip]) * fr) * g;
      pos += step;
      env *= decay;
      played++;
      if (--gate <= 0) killing = true;
      if (killing) {
        fade -= 1 / KILL_FRAMES;
        if (fade <= 0) { this.active = false; break; }
      }
    }
    if (env < 1e-4) this.active = false;
    this.pos = pos; this.env = env; this.fade = fade; this.played = played; this.gate = gate; this.killing = killing;
  }

  private aligned = 0;

  /**
   * Pick where a new grain should start reading: near `target`, but shifted so that it lines
   * up with what the other grain (reading at `ref`) is playing. Without this, two grains of a
   * steady tone meet out of phase and the sound warbles. The answer is left in `this.aligned`.
   */
  private align(L: Float32Array, target: number, ref: number, on: boolean): void {
    const lo = this.from, hi = this.to - 1, dir = this.dir;
    const N = 240, SEARCH = 360;
    const t = target | 0, r = ref | 0;
    this.aligned = target;
    if (!on || (dir > 0 ? r + N >= hi || r < lo : r - N < lo || r >= hi)) return;
    let best = -Infinity;
    for (let d = -SEARCH; d <= SEARCH; d += 2) {
      const s = t + d;
      if (dir > 0 ? s < lo || s + N >= hi : s >= hi || s - N < lo) continue;
      let c = 0;
      if (dir > 0) for (let i = 0; i < N; i += 2) c += L[s + i] * L[r + i];
      else for (let i = 0; i < N; i += 2) c += L[s - i] * L[r - i];
      // prefer the nominal position when several places fit equally well
      c -= Math.abs(c) * 0.0004 * (d < 0 ? -d : d);
      if (c > best) { best = c; this.aligned = s; }
    }
  }

  private renderStretched(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const d = this.data!;
    const L = d.l, R = d.r;
    const lo = this.from, hi = this.to - 1;
    const dir = this.dir, step = this.rate * dir, crawl = this.speed * dir;
    const inc = 1 / GRAIN;
    let pos = this.pos, env = this.env, fade = this.fade, played = this.played, gate = this.gate;
    let p0 = this.gpos0, p1 = this.gpos1, h0 = this.gph0, h1 = this.gph1, on0 = this.gon0, on1 = this.gon1, first = this.first;
    const gain = this.gain, decay = this.decay, soft = this.soft;
    let killing = this.killing;
    for (let i = from; i < to; i++) {
      const more = pos >= lo && pos < hi;
      // the second grain joins half a grain in, and from then on each restarts where the cursor is
      if (!on1 && h0 >= 0.5 && h1 === 0 && more) { on1 = true; this.align(L, pos, p0, true); p1 = this.aligned; }
      let l = 0, r = 0;
      if (on0) {
        if (p0 >= lo && p0 < hi) {
          const ip = p0 | 0, fr = p0 - ip;
          // the very first half-grain is not faded in, so a drum keeps its attack
          const w = first && h0 < 0.5 ? 1 : 0.5 - 0.5 * Math.cos(TAU * h0);
          l += (L[ip] + (L[ip + 1] - L[ip]) * fr) * w;
          r += (R[ip] + (R[ip + 1] - R[ip]) * fr) * w;
        }
        p0 += step;
        h0 += inc;
        if (h0 >= 1) { h0 = 0; first = false; if (more) { this.align(L, pos, p1, on1); p0 = this.aligned; } else on0 = false; }
      }
      if (on1) {
        if (p1 >= lo && p1 < hi) {
          const ip = p1 | 0, fr = p1 - ip;
          const w = 0.5 - 0.5 * Math.cos(TAU * h1);
          l += (L[ip] + (L[ip + 1] - L[ip]) * fr) * w;
          r += (R[ip] + (R[ip + 1] - R[ip]) * fr) * w;
        }
        p1 += step;
        h1 += inc;
        if (h1 >= 1) { h1 = 1e-9; if (more) { this.align(L, pos, p0, on0); p1 = this.aligned; } else on1 = false; }
      }
      if (!on0 && !on1) { this.active = false; break; }
      let g = gain * env * fade;
      if (soft && played < FADE_IN) g *= played / FADE_IN;
      outL[i] += l * g;
      outR[i] += r * g;
      pos += crawl;
      env *= decay;
      played++;
      if (--gate <= 0) killing = true;
      if (killing) {
        fade -= 1 / KILL_FRAMES;
        if (fade <= 0) { this.active = false; break; }
      }
    }
    if (env < 1e-4) this.active = false;
    this.pos = pos; this.env = env; this.fade = fade; this.played = played; this.gate = gate; this.killing = killing;
    this.gpos0 = p0; this.gpos1 = p1; this.gph0 = h0; this.gph1 = h1; this.gon0 = on0; this.gon1 = on1; this.first = first;
  }
}

/** Where the LFO and the mod envelope can be sent. The order is part of the share-link format. */
export const MOD_DESTS = ['cutoff', 'pitch', 'pos', 'pos2', 'pitch2', 'mix', 'noise', 'reso', 'amp', 'pan', 'detune'] as const;
export const MOD_LABELS = ['Cutoff', 'Pitch', 'Osc 1 shape', 'Osc 2 shape', 'Osc 2 pitch', 'Osc mix', 'Noise', 'Resonance', 'Level', 'Pan', 'Detune'];
const enum Dest { Cutoff, Pitch, Pos, Pos2, Pitch2, Mix, Noise, Reso, Amp, Pan, Detune, Count }

export const MAX_UNISON = 5;

/** A track's synth settings, converted to what the voice needs. The engine fills this in. */
export interface SynthPatch {
  wave: number; // 0 saw, 1 square, 2 triangle, 3 sine, 4 = wavetable
  wave2: number;
  table: Wavetable | null;
  table2: Wavetable | null;
  pos: number; // 0..1 along the wavetable
  pos2: number;
  ratio2: number; // oscillator 2 pitch as a ratio of the note
  mix: number; // 0 = oscillator 1 only, 1 = oscillator 2 only
  noise: number; // 0..1
  uni: number; // voices per oscillator
  detune: number; // cents between the outermost unison voices
  spread: number; // 0..1 stereo width of the unison voices
  cutoff: number; // 0..1
  reso: number; // 0..1
  envAmt: number; // 0..1
  attack: number; // seconds
  decayCoef: number; // per-sample
  sustain: number; // 0..1
  releaseCoef: number; // per-sample
  lfoShape: number; // 0 sine, 1 triangle, 2 saw, 3 square, 4 random steps
  lfoHz: number;
  lfoAmt: number; // -1..1
  lfoDest: number;
  menvAttack: number; // seconds
  menvDecay: number; // seconds
  menvAmt: number; // -1..1
  menvDest: number;
}

export function emptyPatch(): SynthPatch {
  return {
    wave: 0, wave2: 0, table: null, table2: null, pos: 0, pos2: 0, ratio2: 1, mix: 0, noise: 0, uni: 1, detune: 0, spread: 0,
    cutoff: 0.5, reso: 0, envAmt: 0, attack: 0.001, decayCoef: 0.999, sustain: 0.5, releaseCoef: 0.999,
    lfoShape: 0, lfoHz: 1, lfoAmt: 0, lfoDest: 0, menvAttack: 0.001, menvDecay: 0.2, menvAmt: 0, menvDest: 0,
  };
}

const enum Stage { Idle, Attack, Decay, Release }
const SUB = 16; // modulation and filter coefficients update every SUB frames
const UNI_GAIN = [0, 1, 0.5, 0.42, 0.36, 0.32]; // keeps a stack about as loud as one voice
const UNI_PHASE = [0, 0.37, 0.71, 0.13, 0.55];

function blep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SynthVoice {
  active = false;
  age = 0;
  pitch = -1;
  held = false; // true while a live key is down (no scheduled gate)
  private stage: Stage = Stage.Idle;
  private level = 0;
  private gate = 0; // frames until release, for sequenced notes
  private dt = 0;
  private gain = 0;
  private fastRelease = 0;
  private seed = 1;
  // oscillators: one phase and one increment per unison voice
  private ph1 = new Float64Array(MAX_UNISON);
  private ph2 = new Float64Array(MAX_UNISON);
  private dt1 = new Float64Array(MAX_UNISON);
  private dt2 = new Float64Array(MAX_UNISON);
  private upan = new Float64Array(MAX_UNISON);
  // filter (mid and side share coefficients)
  private m1 = 0; private m2 = 0; private s1 = 0; private s2 = 0;
  private g = 0; private k = 1;
  // modulation, refreshed every SUB frames
  private mod = new Float64Array(Dest.Count);
  private lfoPh = 0;
  private lfoHold = 0;
  private menvT = 0;
  private g1 = 1; private g2 = 0; private gn = 0;
  private a1: Float32Array | null = null; private b1: Float32Array | null = null; private f1 = 0;
  private a2: Float32Array | null = null; private b2: Float32Array | null = null; private f2 = 0;
  private amp = 1; private panL = 1; private panR = 1; private side = 0;

  constructor(private sampleRate: number) {}

  start(pitch: number, vel: number, gateFrames: number, age: number): void {
    const wasActive = this.active;
    this.pitch = pitch;
    this.dt = (440 * Math.pow(2, (pitch - 69) / 12)) / this.sampleRate;
    this.gain = Math.pow(vel / 127, 1.5) * 0.3;
    this.gate = gateFrames;
    this.held = !Number.isFinite(gateFrames);
    this.stage = Stage.Attack;
    this.fastRelease = 0;
    this.age = age;
    this.menvT = 0;
    this.lfoPh = 0;
    if (!wasActive) {
      this.level = 0;
      for (let u = 0; u < MAX_UNISON; u++) { this.ph1[u] = UNI_PHASE[u]; this.ph2[u] = (UNI_PHASE[u] + 0.21) % 1; }
      this.m1 = this.m2 = this.s1 = this.s2 = 0;
    }
    this.active = true;
  }

  release(): void {
    if (this.stage !== Stage.Idle) this.stage = Stage.Release;
    this.held = false;
    this.gate = Infinity;
  }

  /** Release within ~3ms, used when stealing or on panic. */
  kill(): void {
    this.release();
    this.fastRelease = Math.exp(-1 / (0.003 * this.sampleRate));
  }

  get envLevel(): number {
    return this.active ? this.level : 0;
  }

  /** Work out everything that changes slowly: modulation, pitches, mix, wavetable frames, filter. */
  private control(p: SynthPatch): void {
    const sr = this.sampleRate, md = this.mod, level = this.level;
    md.fill(0);
    if (p.lfoAmt) {
      const ph = this.lfoPh;
      let v: number;
      if (p.lfoShape === 0) v = Math.sin(TAU * ph);
      else if (p.lfoShape === 1) v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      else if (p.lfoShape === 2) v = 1 - 2 * ph;
      else if (p.lfoShape === 3) v = ph < 0.5 ? 1 : -1;
      else v = this.lfoHold;
      md[p.lfoDest] += v * p.lfoAmt;
      const next = ph + (p.lfoHz * SUB) / sr;
      if (next >= 1) {
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
        this.lfoHold = this.seed / 2147483648;
      }
      this.lfoPh = next - Math.floor(next);
    }
    if (p.menvAmt) {
      const t = this.menvT;
      const v = t < p.menvAttack ? t / p.menvAttack : Math.exp(-(t - p.menvAttack) / p.menvDecay);
      md[p.menvDest] += v * p.menvAmt;
      this.menvT = t + SUB / sr;
    }

    // pitch moves on a cubic curve: gentle vibrato near the middle, two octaves at the ends
    const pm = md[Dest.Pitch], pm2 = md[Dest.Pitch2];
    const base = pm ? this.dt * Math.pow(2, 2 * pm * Math.abs(pm)) : this.dt;
    const second = base * p.ratio2 * (pm2 ? Math.pow(2, 2 * pm2 * Math.abs(pm2)) : 1);
    const uni = p.uni;
    const cents = Math.max(0, p.detune + md[Dest.Detune] * 100);
    let top = 0;
    for (let u = 0; u < uni; u++) {
      const x = uni > 1 ? u / (uni - 1) - 0.5 : 0; // -0.5..0.5 across the stack
      const r = cents ? Math.pow(2, (x * cents) / 1200) : 1;
      this.dt1[u] = base * r;
      this.dt2[u] = second * r;
      this.upan[u] = x * 2 * (u & 1 ? -1 : 1);
      if (this.dt1[u] > top) top = this.dt1[u];
    }
    this.side = uni > 1 ? p.spread : 0;

    const mix = clamp01(p.mix + md[Dest.Mix]);
    const norm = UNI_GAIN[uni];
    this.g1 = (1 - mix) * norm;
    this.g2 = mix * norm;
    this.gn = clamp01(p.noise + md[Dest.Noise]);

    if (p.table) {
      const x = clamp01(p.pos + md[Dest.Pos]) * (WT_FRAMES - 1);
      const f = Math.min(WT_FRAMES - 2, x | 0);
      const rows = p.table.frames[mipFor(top)];
      this.a1 = rows[f]; this.b1 = rows[f + 1]; this.f1 = x - f;
    }
    if (p.table2) {
      const x = clamp01(p.pos2 + md[Dest.Pos2]) * (WT_FRAMES - 1);
      const f = Math.min(WT_FRAMES - 2, x | 0);
      const rows = p.table2.frames[mipFor(second * (cents ? Math.pow(2, cents / 2400) : 1))];
      this.a2 = rows[f]; this.b2 = rows[f + 1]; this.f2 = x - f;
    }

    const oct = p.cutoff * 9.3 + level * p.envAmt * 6 + md[Dest.Cutoff] * 6;
    let fc = 30 * Math.pow(2, oct);
    const max = sr * 0.45;
    if (fc > max) fc = max; else if (fc < 20) fc = 20;
    this.g = Math.tan((Math.PI * fc) / sr);
    this.k = 2 - 1.94 * clamp01(p.reso + md[Dest.Reso]);

    const amp = 1 + md[Dest.Amp];
    this.amp = amp < 0 ? 0 : amp > 2 ? 2 : amp;
    const pan = md[Dest.Pan];
    this.panL = pan > 0 ? (pan > 1 ? 0 : 1 - pan) : 1;
    this.panR = pan < 0 ? (pan < -1 ? 0 : 1 + pan) : 1;
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, p: SynthPatch): void {
    const sr = this.sampleRate;
    const atkInc = 1 / Math.max(1, p.attack * sr);
    const relCoef = this.fastRelease || p.releaseCoef;
    const uni = p.uni, wave = p.wave, wave2 = p.wave2;
    const ph1 = this.ph1, ph2 = this.ph2, dt1 = this.dt1, dt2 = this.dt2, upan = this.upan;
    const gain = this.gain;
    let level = this.level, gate = this.gate, stage = this.stage, seed = this.seed;
    let m1 = this.m1, m2 = this.m2, s1 = this.s1, s2 = this.s2;

    for (let at = from; at < to && this.active;) {
      const end = Math.min(to, at + SUB);
      this.seed = seed;
      this.level = level; // passed through a field: a number argument would be boxed on every call
      this.control(p);
      seed = this.seed;
      const g = this.g, k = this.k, g1 = this.g1, g2 = this.g2, gn = this.gn, side = this.side;
      const a1 = this.a1, b1 = this.b1, f1 = this.f1, a2 = this.a2, b2 = this.b2, f2 = this.f2;
      const outGain = gain * this.amp, panL = this.panL, panR = this.panR;
      const c1 = 1 / (1 + g * (g + k)), c2 = g * c1, c3 = g * c2;
      for (let i = at; i < end; i++) {
        if (gate <= 0 && stage !== Stage.Release) stage = Stage.Release;
        gate--;
        if (stage === Stage.Attack) {
          level += atkInc;
          if (level >= 1) { level = 1; stage = Stage.Decay; }
        } else if (stage === Stage.Decay) {
          level = p.sustain + (level - p.sustain) * p.decayCoef;
        } else {
          level *= relCoef;
          if (level < 1e-4) { level = 0; stage = Stage.Idle; this.active = false; break; }
        }
        let mid = 0, sd = 0;
        for (let u = 0; u < uni; u++) {
          // Both oscillators are written out in full here. A helper returning a number
          // would make the engine allocate one per sample, and the audio thread must never allocate.
          let x = 0;
          if (g1 > 0) {
            const ph = ph1[u], d = dt1[u];
            let y: number;
            if (wave === 0) y = 2 * ph - 1 - blep(ph, d);
            else if (wave === 1) {
              let h = ph + 0.5; if (h >= 1) h -= 1;
              y = ((ph < 0.5 ? 1 : -1) + blep(ph, d) - blep(h, d)) * 0.8;
            } else if (wave === 2) y = (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) * 1.1;
            else if (wave === 3 || !a1 || !b1) y = Math.sin(TAU * ph);
            else {
              const w = ph * WT_SIZE, i0 = w | 0, fr = w - i0, i1 = (i0 + 1) & (WT_SIZE - 1);
              const s0 = a1[i0] + (a1[i1] - a1[i0]) * fr;
              y = s0 + (b1[i0] + (b1[i1] - b1[i0]) * fr - s0) * f1;
            }
            x = y * g1;
            const n = ph + d;
            ph1[u] = n >= 1 ? n - 1 : n;
          }
          if (g2 > 0) {
            const ph = ph2[u], d = dt2[u];
            let y: number;
            if (wave2 === 0) y = 2 * ph - 1 - blep(ph, d);
            else if (wave2 === 1) {
              let h = ph + 0.5; if (h >= 1) h -= 1;
              y = ((ph < 0.5 ? 1 : -1) + blep(ph, d) - blep(h, d)) * 0.8;
            } else if (wave2 === 2) y = (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) * 1.1;
            else if (wave2 === 3 || !a2 || !b2) y = Math.sin(TAU * ph);
            else {
              const w = ph * WT_SIZE, i0 = w | 0, fr = w - i0, i1 = (i0 + 1) & (WT_SIZE - 1);
              const s0 = a2[i0] + (a2[i1] - a2[i0]) * fr;
              y = s0 + (b2[i0] + (b2[i1] - b2[i0]) * fr - s0) * f2;
            }
            x += y * g2;
            const n = ph + d;
            ph2[u] = n >= 1 ? n - 1 : n;
          }
          mid += x;
          sd += x * upan[u];
        }
        if (gn > 0) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
          mid += (seed / 2147483648) * gn * 0.5;
        }
        // state-variable low-pass (TPT form, stable under fast modulation)
        let v3 = mid - m2;
        let v1 = c1 * m1 + c2 * v3;
        let v2 = m2 + c2 * m1 + c3 * v3;
        m1 = 2 * v1 - m1;
        m2 = 2 * v2 - m2;
        const a = level * outGain;
        const y = v2 * a;
        if (side > 0) {
          // the unison voices are fanned out left and right; the difference signal gets the same filter
          v3 = sd * side - s2;
          v1 = c1 * s1 + c2 * v3;
          v2 = s2 + c2 * s1 + c3 * v3;
          s1 = 2 * v1 - s1;
          s2 = 2 * v2 - s2;
          const w = v2 * a;
          outL[i] += (y + w) * panL;
          outR[i] += (y - w) * panR;
        } else {
          outL[i] += y * panL;
          outR[i] += y * panR;
        }
      }
      at = end;
    }
    this.level = level; this.gate = gate; this.stage = stage; this.seed = seed;
    this.m1 = m1; this.m2 = m2; this.s1 = s1; this.s2 = s2;
  }
}
