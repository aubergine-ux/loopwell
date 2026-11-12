// The whole instrument as a pure, DOM-free class: sequencer, voices, mixer and
// effects. The AudioWorklet runs it in real time; export and the tests run the
// very same code offline, so what you hear is what you render.

import { StepClock, samplesPerStep } from './clock';
import { Compressor, DjFilter, PingPongDelay, Reverb, softClip } from './dsp/fx';
import { SampleVoice, SynthVoice, type SampleData, type SynthPatch } from './dsp/voices';
import { DELAY_DIVS, MAX_TRACKS, emptyProject, type Project, type Track } from './types';

const BLOCK = 128;
const SAMPLE_VOICES = 6;
const SAMPLE_POLY = 4;
const SYNTH_VOICES = 6;

export interface StepInfo {
  step: number;
  pattern: number;
  songPos: number;
  /** Frame offset of this step inside the block being processed. */
  offset: number;
}

class Channel {
  l = new Float32Array(BLOCK);
  r = new Float32Array(BLOCK);
  samples: SampleVoice[] = [];
  synths: SynthVoice[] = [];
  filter: DjFilter;
  gl = -1; gr = 0; // current (smoothed) output gains; -1 = not set yet
  patch: SynthPatch = { wave: 0, cutoff: 0.5, reso: 0, envAmt: 0, attack: 0.001, decayCoef: 0.999, sustain: 0.5, releaseCoef: 0.999 };
  constructor(sr: number) {
    for (let i = 0; i < SAMPLE_VOICES; i++) this.samples.push(new SampleVoice());
    for (let i = 0; i < SYNTH_VOICES; i++) this.synths.push(new SynthVoice(sr));
    this.filter = new DjFilter(sr);
  }
}

const volGain = (v: number) => (v / 100) * (v / 100);
const send = (v: number) => (v / 127) * (v / 127);

export class Engine {
  readonly clock: StepClock;
  project: Project = emptyProject();
  playing = false;
  /** Set when a non-looping chain has played its last step. */
  ended = false;
  pattern = 0;
  queued = -1;
  songPos = 0;
  stepIdx = 0;
  /** Solo exactly one track and skip the master compressor (stem export). */
  stem = -1;
  onStep: ((info: StepInfo) => void) | null = null;

  /** Per-track post-fader peaks since the last readMeters(). */
  readonly peaks = new Float32Array(MAX_TRACKS);
  masterPeakL = 0;
  masterPeakR = 0;

  private samples = new Map<string, SampleData>();
  private ch: Channel[] = [];
  private mixL = new Float32Array(BLOCK);
  private mixR = new Float32Array(BLOCK);
  private revIn = new Float32Array(BLOCK);
  private dlyIn = new Float32Array(BLOCK);
  private reverb: Reverb;
  private delay: PingPongDelay;
  private masterFilter: DjFilter;
  private comp: Compressor;
  private masterGain = 1;
  private age = 0;
  private started = false;
  private chain: number[] | null = null;
  private loop = true;
  private from = 0;
  private nt = 0;
  private info: StepInfo = { step: 0, pattern: 0, songPos: 0, offset: 0 };

  constructor(readonly sampleRate: number) {
    this.clock = new StepClock(sampleRate);
    for (let i = 0; i < MAX_TRACKS; i++) this.ch.push(new Channel(sampleRate));
    this.reverb = new Reverb(sampleRate);
    this.delay = new PingPongDelay(sampleRate);
    this.masterFilter = new DjFilter(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.setProject(this.project);
  }

  get compReduction(): number {
    return this.comp.reduction;
  }

  setProject(p: Project): void {
    this.project = p;
    this.clock.bpm = p.bpm;
    this.clock.swing = p.swing;
    const sr = this.sampleRate;
    for (let i = 0; i < p.tracks.length && i < MAX_TRACKS; i++) {
      const s = p.tracks[i].synth;
      const patch = this.ch[i].patch;
      patch.wave = s.wave;
      patch.cutoff = s.cutoff / 127;
      patch.reso = s.reso / 127;
      patch.envAmt = s.env / 127;
      patch.attack = 0.001 * Math.pow(2000, s.attack / 127);
      patch.decayCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.decay / 127) * sr) / 3));
      patch.sustain = s.sustain / 127;
      patch.releaseCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.release / 127) * sr) / 3));
    }
  }

  setSample(id: string, l: Float32Array, r?: Float32Array): void {
    this.samples.set(id, { l, r: r ?? l });
  }

  hasSample(id: string): boolean {
    return this.samples.has(id);
  }

  /**
   * Start from the top. With `chain`, plays those patterns in order (and stops
   * at the end unless `loop`); otherwise follows the project's song/pattern mode.
   */
  play(opts: { chain?: number[]; loop?: boolean; pattern?: number } = {}): void {
    this.clock.reset();
    this.stepIdx = 0;
    this.songPos = 0;
    this.started = false;
    this.ended = false;
    this.queued = -1;
    this.chain = opts.chain ?? null;
    this.loop = opts.loop ?? true;
    if (opts.pattern !== undefined) this.pattern = opts.pattern;
    const chain = this.activeChain();
    if (chain) this.pattern = chain[0];
    this.playing = true;
  }

  stop(): void {
    this.playing = false;
    this.queued = -1;
    for (const c of this.ch) for (const v of c.synths) if (v.active && !v.held) v.release();
  }

  /** Silence everything right now. */
  panic(): void {
    for (const c of this.ch) {
      for (const v of c.samples) if (v.active) v.kill();
      for (const v of c.synths) if (v.active) v.kill();
    }
  }

  /** Switch pattern: immediately when stopped, on the next bar line when playing. */
  setPattern(i: number): void {
    if (this.playing && !this.activeChain()) this.queued = i === this.pattern ? -1 : i;
    else if (!this.playing) this.pattern = i;
  }

  /** Play a drum hit or a one-shot synth note right away (pads, MIDI, previews). */
  trigger(track: number, vel: number, pitch?: number): void {
    const t = this.project.tracks[track];
    if (!t) return;
    if (t.kind === 'drum') this.hit(track, t, vel);
    else this.noteOn(track, pitch ?? t.note, vel, this.sampleRate * 0.2);
  }

  noteOn(track: number, pitch: number, vel: number, gateFrames = Infinity): void {
    const c = this.ch[track];
    if (!c || !this.project.tracks[track]) return;
    // re-use the voice already playing this pitch, else a free one, else the quietest
    const vs = c.synths;
    let same: SynthVoice | null = null, free: SynthVoice | null = null, quiet = vs[0];
    for (let i = 0; i < vs.length; i++) {
      const s = vs[i];
      if (!s.active) { if (!free) free = s; continue; }
      if (s.pitch === pitch) { same = s; break; }
      if (!s.held && (quiet.held || s.envLevel < quiet.envLevel)) quiet = s;
    }
    (same ?? free ?? quiet).start(pitch, vel, gateFrames, this.age++);
  }

  noteOff(track: number, pitch: number): void {
    const c = this.ch[track];
    if (!c) return;
    for (const v of c.synths) if (v.active && v.held && v.pitch === pitch) v.release();
  }

  private hit(track: number, t: Track, vel: number): void {
    const data = this.samples.get(t.sample);
    if (!data) return;
    const c = this.ch[track];
    let live = 0;
    let oldest: SampleVoice | null = null;
    let free: SampleVoice | null = null;
    let quiet: SampleVoice = c.samples[0];
    for (let i = 0; i < c.samples.length; i++) {
      const v = c.samples[i];
      if (!v.active) { free ??= v; continue; }
      live++;
      if (!oldest || v.age < oldest.age) oldest = v;
      if (v.level < quiet.level || !quiet.active) quiet = v;
    }
    if (live >= SAMPLE_POLY && oldest) oldest.kill();
    const v = free ?? quiet;
    const g = vel / 127;
    const decay = t.decay >= 127 ? 1 : Math.exp(-1 / (0.012 * Math.pow(330, t.decay / 127) * this.sampleRate));
    v.start(data, Math.pow(2, t.tune / 12), g * g, decay, this.age++);
  }

  private activeChain(): number[] | null {
    if (this.chain) return this.chain;
    const p = this.project;
    return p.songMode && p.song.length ? p.song : null;
  }

  private fire = (_globalStep: number, offset: number): void => {
    if (offset > this.from) { this.voices(this.from, offset, this.nt); this.from = offset; }
    if (!this.playing) return;
    const p = this.project;
    if (this.stepIdx >= p.steps) this.stepIdx = 0;
    if (this.stepIdx === 0 && this.started) {
      const chain = this.activeChain();
      if (chain) {
        this.songPos++;
        if (this.songPos >= chain.length) {
          if (!this.loop) { this.playing = false; this.ended = true; return; }
          this.songPos = 0;
        }
        this.pattern = chain[this.songPos];
      } else if (this.queued >= 0) {
        this.pattern = this.queued;
        this.queued = -1;
      }
    }
    this.started = true;
    const step = this.stepIdx++;
    const pat = p.patterns[this.pattern];
    if (pat) {
      const sps = samplesPerStep(p.bpm, this.sampleRate);
      for (let t = 0; t < p.tracks.length; t++) {
        const tr = p.tracks[t];
        if (tr.kind === 'drum') {
          const vel = pat.steps[t]?.[step];
          if (vel) this.hit(t, tr, vel);
        } else {
          const notes = pat.notes[t];
          if (notes) for (let n = 0; n < notes.length; n++) {
            const nt = notes[n];
            if (nt.s === step) this.noteOn(t, nt.p, nt.v, Math.max(1, Math.round(nt.l * sps * 0.96)));
          }
        }
      }
    }
    if (this.onStep) {
      const info = this.info; // reused: nothing on the audio path allocates
      info.step = step; info.pattern = this.pattern; info.songPos = this.songPos; info.offset = offset;
      this.onStep(info);
    }
  };

  /** Render `frames` of stereo audio. Any length; split into 128-frame blocks inside. */
  process(outL: Float32Array, outR: Float32Array, frames: number, start = 0): void {
    for (let done = 0; done < frames; done += BLOCK) {
      const n = Math.min(BLOCK, frames - done);
      this.block(n);
      outL.set(n === BLOCK ? this.mixL : this.mixL.subarray(0, n), start + done);
      outR.set(n === BLOCK ? this.mixR : this.mixR.subarray(0, n), start + done);
    }
  }

  private block(n: number): void {
    const p = this.project;
    const nt = Math.min(p.tracks.length, MAX_TRACKS);
    for (let t = 0; t < nt; t++) { this.ch[t].l.fill(0, 0, n); this.ch[t].r.fill(0, 0, n); }

    // Voices are rendered in segments split at each step that lands in this
    // block, so a hit starts on its exact frame.
    this.from = 0;
    this.nt = nt;
    if (this.playing) this.clock.advance(n, this.fire);
    this.voices(this.from, n, nt);

    const { mixL, mixR, revIn, dlyIn } = this;
    mixL.fill(0, 0, n); mixR.fill(0, 0, n); revIn.fill(0, 0, n); dlyIn.fill(0, 0, n);
    let anySolo = false;
    for (let t = 0; t < nt; t++) if (p.tracks[t].solo) anySolo = true;

    for (let t = 0; t < nt; t++) {
      const tr = p.tracks[t], c = this.ch[t];
      c.filter.process(c.l, c.r, n, tr.filter / 64, 0.25);
      const on = this.stem >= 0 ? this.stem === t : anySolo ? tr.solo : !tr.mute;
      const g = on ? volGain(tr.vol) : 0;
      const a = ((tr.pan / 64 + 1) * Math.PI) / 4;
      const tl = g * Math.cos(a) * Math.SQRT2, trr = g * Math.sin(a) * Math.SQRT2;
      if (c.gl < 0) { c.gl = tl; c.gr = trr; } // first block: no fade-in
      const dl = (tl - c.gl) / n, dr = (trr - c.gr) / n;
      const rs = send(tr.rev), ds = send(tr.dly);
      let gl = c.gl, gr = c.gr, peak = 0;
      const L = c.l, R = c.r;
      for (let i = 0; i < n; i++) {
        gl += dl; gr += dr;
        const l = L[i] * gl, r = R[i] * gr;
        mixL[i] += l; mixR[i] += r;
        const m = (l + r) * 0.5;
        revIn[i] += m * rs; dlyIn[i] += m * ds;
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
      }
      c.gl = tl; c.gr = trr;
      if (peak > this.peaks[t]) this.peaks[t] = peak;
    }

    const fx = p.fx;
    const sps = samplesPerStep(p.bpm, this.sampleRate);
    this.delay.process(dlyIn, mixL, mixR, n, DELAY_DIVS[fx.dlyTime] * sps, (fx.dlyFb / 127) * 0.85, send(fx.dlyLevel) * 1.2);
    this.reverb.process(revIn, mixL, mixR, n, fx.revSize / 127, fx.revDamp / 127, send(fx.revLevel) * 1.6);
    this.masterFilter.process(mixL, mixR, n, fx.filter / 64, fx.filterRes / 127);
    if (fx.compOn && this.stem < 0) {
      this.comp.process(mixL, mixR, n, -(fx.compThresh / 127) * 36, 1 + (fx.compRatio / 127) * 11, (fx.compMakeup / 127) * 18);
    } else {
      this.comp.reduction = 0;
    }
    const mg = volGain(p.master), dm = (mg - this.masterGain) / n;
    let g = this.masterGain, pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      g += dm;
      mixL[i] *= g; mixR[i] *= g;
    }
    this.masterGain = mg;
    softClip(mixL, n);
    softClip(mixR, n);
    for (let i = 0; i < n; i++) {
      const al = Math.abs(mixL[i]), ar = Math.abs(mixR[i]);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    if (pl > this.masterPeakL) this.masterPeakL = pl;
    if (pr > this.masterPeakR) this.masterPeakR = pr;
  }

  private voices(from: number, to: number, nt: number): void {
    if (to <= from) return;
    for (let t = 0; t < nt; t++) {
      const c = this.ch[t], sm = c.samples, sy = c.synths;
      for (let i = 0; i < sm.length; i++) if (sm[i].active) sm[i].render(c.l, c.r, from, to);
      for (let i = 0; i < sy.length; i++) if (sy[i].active) sy[i].render(c.l, c.r, from, to, c.patch);
    }
  }

  resetMeters(): void {
    this.peaks.fill(0);
    this.masterPeakL = this.masterPeakR = 0;
  }
}
