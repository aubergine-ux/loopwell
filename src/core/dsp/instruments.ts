// The two instruments that make their sound from nothing but knobs: the 808
// bass (one voice that slides between overlapping notes) and the drum synth.
// Like the other voices, both render additively into a stereo block.

const TAU = 2 * Math.PI;
const midiHz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);

/** What the 808 needs to know, worked out from the track's knobs by the engine. */
export interface BassPatch {
  glide: number; // seconds for a slide to (nearly) arrive; 0 = every note starts fresh
  drive: number; // 0..1
  decay: number; // seconds for the level to fall by 60 dB
  tone: number; // 0..1, how much of the saturation's brightness gets through
  punch: number; // 0..1, the pitch drop at the start of a note
}

export const emptyBassPatch = (): BassPatch => ({ glide: 0.08, drive: 0.3, decay: 1.5, tone: 0.5, punch: 0.4 });

export class BassVoice {
  active = false;
  held = false;
  pitch = -1;
  private sr: number;
  private phase = 0;
  private freq = 55;
  private target = 55;
  private env = 0;
  private level = 0;
  private penv = 0;
  private gain = 0;
  private gate = Infinity;
  private releasing = false;
  private rel = 1;
  private lp = 0;
  private attack = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /** Start a note. If one is still sounding and the patch glides, slide to the new pitch instead of starting again. */
  start(pitch: number, vel: number, gateFrames: number, patch: BassPatch): void {
    const f = midiHz(pitch);
    const slide = this.active && !this.releasing && patch.glide > 0;
    this.pitch = pitch;
    this.target = f;
    this.gate = gateFrames;
    this.held = gateFrames === Infinity;
    this.releasing = false;
    this.rel = 1;
    if (slide) return;
    this.freq = f;
    // carry on from the level it was at, so cutting a ringing note short doesn't click
    this.level = this.active ? this.env * this.gain : 0;
    const g = vel / 127;
    this.gain = g * g;
    this.env = 1;
    this.penv = 1;
    this.attack = 0;
    if (!this.active) { this.phase = 0; this.lp = 0; }
    this.active = true;
  }

  release(): void {
    this.releasing = true;
    this.held = false;
  }

  kill(): void {
    this.releasing = true;
    this.held = false;
    this.rel = Math.min(this.rel, 0.2);
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, p: BassPatch): void {
    const sr = this.sr;
    const glide = p.glide > 0 ? 1 - Math.exp(-1 / (p.glide * sr * 0.3)) : 1;
    const decay = Math.exp(-6.9 / (p.decay * sr));
    const pdecay = Math.exp(-1 / (0.012 * sr));
    const relStep = 1 / (0.03 * sr);
    const atkStep = 1 / (0.002 * sr);
    const pre = 1 + p.drive * p.drive * 14;
    const norm = 1 / Math.tanh(pre);
    // the saturation adds harmonics; tone decides how far up they are allowed to go
    const lpc = 1 - Math.exp((-TAU * (120 * Math.pow(60, p.tone))) / sr);
    const punch = p.punch * 3;
    let { phase, freq, env, penv, rel, lp, gate, attack, level } = this;
    const target = this.target, gain = this.gain;
    let releasing = this.releasing;
    for (let i = from; i < to; i++) {
      freq += (target - freq) * glide;
      phase += (freq * (1 + punch * penv)) / sr;
      if (phase >= 1) phase -= 1;
      const dry = Math.sin(TAU * phase);
      const wet = Math.tanh(dry * pre) * norm;
      lp += (wet - lp) * lpc;
      // the fundamental always comes through whole; the filter only tames what the drive added
      let amp = env * gain;
      if (attack < 1) { amp = level + (amp - level) * attack; attack += atkStep; }
      const x = (dry * (1 - p.drive * 0.5) + lp * (0.4 + p.drive * 0.6)) * amp * rel * 0.8;
      outL[i] += x;
      outR[i] += x;
      env *= decay;
      penv *= pdecay;
      if (--gate <= 0) releasing = true;
      if (releasing) {
        rel -= relStep;
        if (rel <= 0) { this.active = false; break; }
      }
    }
    if (env < 1e-4) this.active = false;
    if (!this.active) this.pitch = -1;
    this.phase = phase; this.freq = freq; this.env = env; this.penv = penv; this.rel = rel; this.lp = lp;
    this.gate = gate; this.attack = attack; this.releasing = releasing;
  }
}

// --- drum synth ------------------------------------------------------------

export const DRUM_MODELS = ['Kick', 'Snare', 'Hat', 'Clap'] as const;
export const enum Drum { Kick, Snare, Hat, Clap }

/** The drum synth's four knobs, all 0..1 except `tune` (semitones). What each one does depends on the model. */
export interface DrumPatch {
  model: number;
  tune: number;
  decay: number;
  tone: number;
  snap: number;
}

export const emptyDrumPatch = (): DrumPatch => ({ model: 0, tune: 0, decay: 0.5, tone: 0.5, snap: 0.5 });

const HAT_RATIOS = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523];

export class DrumVoice {
  active = false;
  age = 0;
  private sr: number;
  private model = 0;
  private t = 0; // frames since the hit
  private gain = 0;
  private seed = 0x9e3779b9;
  private ph = new Float64Array(6);
  private f0 = 0; private f1 = 0; private pk = 0;
  private env = 0; private dk = 0;
  private nenv = 0; private ndk = 0;
  private snap = 0; private tone = 0;
  // one state-variable filter for the noise
  private lo = 0; private bd = 0; private fc = 0; private q = 0;
  private hp = 0; private hpz = 0; private hpc = 0;
  private fade = 1; private killing = false;
  private end = 0;
  private bursts = 0; private gap = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  start(p: DrumPatch, vel: number, age: number): void {
    const sr = this.sr;
    const ratio = Math.pow(2, p.tune / 12);
    const g = vel / 127;
    this.model = p.model;
    this.gain = g * g;
    this.age = age;
    this.t = 0;
    this.fade = 1;
    this.killing = false;
    this.ph.fill(0);
    this.lo = this.bd = this.hp = this.hpz = 0;
    this.snap = p.snap;
    this.tone = p.tone;
    this.env = 1;
    this.nenv = 1;
    const tau = (sec: number) => Math.exp(-1 / (sec * sr));
    let len: number;
    if (p.model === Drum.Kick) {
      // a sine that drops from a click down to the note; snap is how far and how fast it falls
      this.f1 = 48 * ratio;
      this.f0 = this.f1 * (1 + p.snap * 9);
      this.pk = tau(0.006 + (1 - p.snap) * 0.03);
      len = 0.08 + p.decay * p.decay * 1.6;
      this.dk = tau(len / 5);
    } else if (p.model === Drum.Snare) {
      // two short tones for the shell, noise for the wires
      this.f1 = 185 * ratio;
      this.f0 = this.f1 * 1.6;
      this.pk = tau(0.01);
      this.dk = tau(0.03 + p.decay * 0.09);
      len = 0.07 + p.decay * 0.5;
      this.ndk = tau(len / 4.5);
      this.fc = 2 * Math.sin((Math.PI * Math.min(0.24 * sr, 1800 + p.tone * 6500)) / sr);
      this.q = 1.4;
    } else if (p.model === Drum.Hat) {
      // six detuned squares, the 808 recipe, with everything low taken out
      this.f1 = 3200 * ratio * (0.6 + p.tone * 0.9);
      len = 0.025 + p.decay * p.decay * 0.9;
      this.dk = tau(len / 4.5);
      this.hpc = Math.exp((-TAU * Math.min(0.4 * sr, 5000 + p.tone * 5000)) / sr);
    } else {
      // a few bursts of band-passed noise close together, then a tail: several hands, one room
      this.fc = 2 * Math.sin((Math.PI * Math.min(0.24 * sr, (800 + p.tone * 1800) * ratio)) / sr);
      this.q = 0.9;
      this.bursts = 3;
      this.gap = Math.round((0.006 + p.snap * 0.012) * sr);
      this.dk = tau(0.004 + p.snap * 0.004);
      len = 0.08 + p.decay * 0.6;
      this.ndk = tau(len / 4.5);
    }
    this.end = Math.round(len * 1.6 * sr) + (p.model === Drum.Clap ? this.gap * 3 : 0);
    this.active = true;
  }

  kill(): void {
    this.killing = true;
  }

  get level(): number {
    return this.active ? this.fade * (this.model === Drum.Clap || this.model === Drum.Snare ? this.nenv : this.env) : 0;
  }

  private noise(): number {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return x / 2147483648;
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const sr = this.sr, ph = this.ph, model = this.model, gain = this.gain;
    for (let i = from; i < to; i++) {
      let x = 0;
      if (model === Drum.Kick) {
        this.f0 = this.f1 + (this.f0 - this.f1) * this.pk;
        ph[0] += this.f0 / sr;
        const s = Math.sin(TAU * ph[0]);
        // tone pushes the sine into a soft clip for a harder, buzzier kick
        const d = 1 + this.tone * 5;
        x = (Math.tanh(s * d) / Math.tanh(d)) * this.env;
        this.env *= this.dk;
      } else if (model === Drum.Snare) {
        this.f0 = this.f1 + (this.f0 - this.f1) * this.pk;
        ph[0] += this.f0 / sr;
        ph[1] += (this.f0 * 1.78) / sr;
        const shell = (Math.sin(TAU * ph[0]) + 0.5 * Math.sin(TAU * ph[1])) * this.env;
        const n = this.noise();
        this.lo += this.fc * this.bd;
        const high = n - this.lo - this.bd / this.q;
        this.bd += this.fc * high;
        x = shell * (1 - this.snap * 0.6) * 0.8 + (high * 0.6 + this.bd * 0.5) * this.nenv * (0.25 + this.snap * 0.9);
        this.env *= this.dk;
        this.nenv *= this.ndk;
      } else if (model === Drum.Hat) {
        let m = 0;
        for (let k = 0; k < 6; k++) {
          ph[k] += (this.f1 * HAT_RATIOS[k]) / sr;
          if (ph[k] >= 1) ph[k] -= 1;
          m += ph[k] < 0.5 ? 1 : -1;
        }
        // snap blends the ringing metal with plain hiss
        const s = (m / 6) * (1 - this.snap * 0.7) + this.noise() * (0.25 + this.snap * 0.6);
        this.hpz = this.hpc * (this.hpz + s - this.hp);
        this.hp = s;
        x = this.hpz * this.env * 0.9;
        this.env *= this.dk;
      } else {
        const n = this.noise();
        this.lo += this.fc * this.bd;
        const high = n - this.lo - this.bd / this.q;
        this.bd += this.fc * high;
        if (this.bursts > 0 && this.t > 0 && this.t % this.gap === 0) { this.env = 1; this.bursts--; }
        const e = this.bursts > 0 ? this.env : this.env > this.nenv ? this.env : this.nenv;
        x = this.bd * e * 1.5;
        this.env *= this.dk;
        if (this.bursts === 0) this.nenv *= this.ndk;
      }
      x *= gain * this.fade;
      outL[i] += x;
      outR[i] += x;
      this.t++;
      if (this.killing) {
        this.fade -= 1 / 96;
        if (this.fade <= 0) { this.active = false; break; }
      }
      if (this.t >= this.end) { this.active = false; break; }
    }
  }
}
