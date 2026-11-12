// Sample and synth voices. Both render additively into a stereo block.

export interface SampleData {
  l: Float32Array;
  r: Float32Array; // same array as l for mono
}

const KILL_FRAMES = 96;

export class SampleVoice {
  active = false;
  age = 0;
  private data: SampleData | null = null;
  private pos = 0;
  private rate = 1;
  private gain = 0;
  private env = 1;
  private decay = 1;
  private fade = 1;
  private killing = false;

  start(data: SampleData, rate: number, gain: number, decayCoef: number, age: number): void {
    this.data = data;
    this.pos = 0;
    this.rate = rate;
    this.gain = gain;
    this.env = 1;
    this.decay = decayCoef;
    this.fade = 1;
    this.killing = false;
    this.active = true;
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
    const d = this.data!;
    const L = d.l, R = d.r;
    const last = L.length - 1;
    let pos = this.pos, env = this.env, fade = this.fade;
    const rate = this.rate, gain = this.gain, decay = this.decay, killing = this.killing;
    for (let i = from; i < to; i++) {
      const ip = pos | 0;
      if (ip >= last) { this.active = false; break; }
      const fr = pos - ip;
      let g = gain * env * fade;
      const tail = last - pos;
      if (tail < 64) g *= tail / 64; // de-click samples that don't end at zero
      outL[i] += (L[ip] + (L[ip + 1] - L[ip]) * fr) * g;
      outR[i] += (R[ip] + (R[ip + 1] - R[ip]) * fr) * g;
      pos += rate;
      env *= decay;
      if (killing) {
        fade -= 1 / KILL_FRAMES;
        if (fade <= 0) { this.active = false; break; }
      }
    }
    if (env < 1e-4) this.active = false;
    this.pos = pos;
    this.env = env;
    this.fade = fade;
  }
}

export interface SynthPatch {
  wave: number;
  cutoff: number; // 0..1
  reso: number; // 0..1
  envAmt: number; // 0..1
  attack: number; // seconds
  decayCoef: number; // per-sample
  sustain: number; // 0..1
  releaseCoef: number; // per-sample
}

const enum Stage { Idle, Attack, Decay, Release }
const DETUNE = Math.pow(2, 7 / 1200);
const SUB = 16; // filter coefficients update every SUB frames

function blep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

export class SynthVoice {
  active = false;
  age = 0;
  pitch = -1;
  held = false; // true while a live key is down (no scheduled gate)
  private stage: Stage = Stage.Idle;
  private level = 0;
  private gate = 0; // frames until release, for sequenced notes
  private ph1 = 0;
  private ph2 = 0;
  private dt = 0;
  private gain = 0;
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 1;
  private sub = 0;
  private fastRelease = 0;

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
    this.sub = 0;
    if (!wasActive) {
      this.level = 0;
      this.ph1 = 0;
      this.ph2 = 0.37;
      this.ic1 = this.ic2 = 0;
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

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, p: SynthPatch): void {
    const sr = this.sampleRate;
    const dt1 = this.dt, dt2 = this.dt * DETUNE;
    const wave = p.wave;
    const atkInc = 1 / Math.max(1, p.attack * sr);
    const relCoef = this.fastRelease || p.releaseCoef;
    const two = wave < 2; // saw and square get a second, detuned oscillator
    let ph1 = this.ph1, ph2 = this.ph2, level = this.level, ic1 = this.ic1, ic2 = this.ic2;
    let g = this.g, k = this.k, sub = this.sub, gate = this.gate, stage = this.stage;
    const gain = this.gain;
    for (let i = from; i < to; i++) {
      if (gate <= 0 && stage !== Stage.Release) stage = Stage.Release;
      gate--;
      // envelope
      if (stage === Stage.Attack) {
        level += atkInc;
        if (level >= 1) { level = 1; stage = Stage.Decay; }
      } else if (stage === Stage.Decay) {
        level = p.sustain + (level - p.sustain) * p.decayCoef;
      } else {
        level *= relCoef;
        if (level < 1e-4) { level = 0; stage = Stage.Idle; this.active = false; break; }
      }
      // filter coefficients
      if (sub-- <= 0) {
        sub = SUB - 1;
        const oct = p.cutoff * 9.3 + level * p.envAmt * 6;
        let fc = 30 * Math.pow(2, oct);
        const max = sr * 0.45;
        if (fc > max) fc = max;
        g = Math.tan((Math.PI * fc) / sr);
        k = 2 - 1.94 * p.reso;
      }
      // oscillators
      let x: number;
      if (wave === 0) {
        x = 2 * ph1 - 1 - blep(ph1, dt1);
        x += 2 * ph2 - 1 - blep(ph2, dt2);
        x *= 0.5;
      } else if (wave === 1) {
        let h = ph1 + 0.5; if (h >= 1) h -= 1;
        x = (ph1 < 0.5 ? 1 : -1) + blep(ph1, dt1) - blep(h, dt1);
        h = ph2 + 0.5; if (h >= 1) h -= 1;
        x += (ph2 < 0.5 ? 1 : -1) + blep(ph2, dt2) - blep(h, dt2);
        x *= 0.4;
      } else if (wave === 2) {
        x = (ph1 < 0.5 ? 4 * ph1 - 1 : 3 - 4 * ph1) * 1.1;
      } else {
        x = Math.sin(2 * Math.PI * ph1);
      }
      ph1 += dt1; if (ph1 >= 1) ph1 -= 1;
      if (two) { ph2 += dt2; if (ph2 >= 1) ph2 -= 1; }
      // state-variable low-pass (TPT form, stable under fast modulation)
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + g * a2 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      const y = v2 * level * gain;
      outL[i] += y;
      outR[i] += y;
    }
    this.ph1 = ph1; this.ph2 = ph2; this.level = level;
    this.ic1 = ic1; this.ic2 = ic2; this.g = g; this.k = k;
    this.sub = sub; this.gate = gate; this.stage = stage;
  }
}
