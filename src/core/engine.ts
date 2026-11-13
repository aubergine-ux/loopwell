// The whole instrument as a pure, DOM-free class: sequencer, voices, mixer and
// effects. The AudioWorklet runs it in real time; export and the tests run the
// very same code offline, so what you hear is what you render.

import { barStart, curveAt, songEnd } from './arrange';
import { StepClock, samplesPerStep } from './clock';
import { ARP_RATES, CHANCES, GROOVES, arpIndex, condPass, modChance, modCond, modRatchet } from './creative';
import { Compressor, DjFilter, PingPongDelay, Reverb, softClip } from './dsp/fx';
import { createInsert, type Insert } from './dsp/inserts';
import { BassVoice, DrumVoice, emptyBassPatch, emptyDrumPatch, type BassPatch, type DrumPatch } from './dsp/instruments';
import { SampleVoice, SynthVoice, emptyPatch, type SampleData, type SynthPatch } from './dsp/voices';
import { wavetable, type Wavetable } from './dsp/wavetable';
import { PARAMS, paramIndex } from './params';
import { toFrame } from './slicer';
import { DELAY_DIVS, LFO_DIVS, MAX_INSERTS, MAX_TRACKS, emptyProject, type Clip, type InsertFx, type Pattern, type Project, type Track } from './types';

// Effective knob values live in flat arrays, so automation can move them
// without touching the project. Indices follow PARAMS.
const NP = PARAMS.length;
const P_VOL = paramIndex('vol'), P_PAN = paramIndex('pan'), P_FILTER = paramIndex('filter'), P_REV = paramIndex('rev'),
  P_DLY = paramIndex('dly'), P_TUNE = paramIndex('tune'), P_DECAY = paramIndex('decay'),
  P_CUTOFF = paramIndex('cutoff'), P_RESO = paramIndex('reso'), P_ENV = paramIndex('env'),
  P_MASTER = paramIndex('master'), P_MFILTER = paramIndex('mfilter'), P_MRES = paramIndex('mres'),
  P_REVLVL = paramIndex('revlvl'), P_REVSIZE = paramIndex('revsize'), P_DLYLVL = paramIndex('dlylvl'), P_DLYFB = paramIndex('dlyfb'),
  P_POS = paramIndex('pos'), P_POS2 = paramIndex('pos2'), P_MIX = paramIndex('mix'), P_NOISE = paramIndex('noise'),
  P_DETUNE = paramIndex('detune'), P_SPREAD = paramIndex('spread'), P_LFORATE = paramIndex('lforate'), P_LFOAMT = paramIndex('lfoamt'),
  P_MENVAMT = paramIndex('menvamt'), P_STRETCH = paramIndex('stretch'),
  P_BDRIVE = paramIndex('bdrive'), P_BDECAY = paramIndex('bdecay'), P_BTONE = paramIndex('btone'), P_BGLIDE = paramIndex('bglide'),
  P_DTUNE = paramIndex('dtune'), P_DDECAY = paramIndex('ddecay'), P_DTONE = paramIndex('dtone'), P_DSNAP = paramIndex('dsnap');

interface Curve {
  slot: number; // index into the value array
  track: number;
  points: { t: number; v: number }[];
}

const BLOCK = 128;
const SAMPLE_VOICES = 6;
const SAMPLE_POLY = 4;
const SYNTH_VOICES = 6;
const DRUM_VOICES = 3;
/** Hits waiting for their frame: ratchets, grooved steps and arpeggios. */
const MAX_PENDING = 256;
const MAX_HELD = 16;

export interface StepInfo {
  /** Step of the pattern (pattern mode) or of the song (song mode). */
  step: number;
  pattern: number;
  /** Position on the timeline in steps, or -1 while a single pattern loops. */
  song: number;
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
  patch: SynthPatch = emptyPatch();
  bass: BassVoice;
  /** The note the 808 was last asked for, before any key shift, so a note-off can find it. */
  bassNote = -1;
  bassPatch: BassPatch = emptyBassPatch();
  drums: DrumVoice[] = [];
  drumPatch: DrumPatch = emptyDrumPatch();
  /** The effect rack: one slot per insert, in playing order. */
  inserts: (Insert | null)[] = [];
  kinds: string[] = [];
  rack: InsertFx[] = [];
  constructor(sr: number) {
    for (let i = 0; i < SAMPLE_VOICES; i++) this.samples.push(new SampleVoice());
    for (let i = 0; i < SYNTH_VOICES; i++) this.synths.push(new SynthVoice(sr));
    for (let i = 0; i < DRUM_VOICES; i++) this.drums.push(new DrumVoice(sr));
    this.bass = new BassVoice(sr);
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
  /** Next timeline step to play (song mode). */
  songStep = 0;
  /** True while the timeline, not a single pattern, is driving playback. */
  inSong = false;
  /** Solo exactly one track and skip the master compressor (stem export). */
  stem = -1;
  /** While true, "fill only" steps play and "not in fill" steps rest. */
  fill = false;
  onStep: ((info: StepInfo) => void) | null = null;
  /**
   * Wavetables take tens of milliseconds to compute. Offline that is fine and they are
   * built when first needed; the audio thread turns this off and is handed them ready-made.
   */
  buildTables = true;
  private tables = new Map<number, Wavetable>();

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
  private info: StepInfo = { step: 0, pattern: 0, song: -1, offset: 0 };
  /** Effective knob values: [track * NP + param] and, for master params, [MAX_TRACKS * NP + param]. */
  private val = new Float32Array((MAX_TRACKS + 1) * NP);
  private curves: Curve[] = [];
  private clips: Clip[][] = [];
  private end = 0;
  private cue = 0;
  private automated = false;
  private sinceStep = 0;
  private curStep = 0;
  /** Times the looping pattern has come round since it started. */
  private loops = 0;
  private seed = 1;
  // hits scheduled for a frame later than the step that asked for them, as parallel arrays so nothing allocates
  private pn = 0;
  private pAt = new Float64Array(MAX_PENDING); // frames from the start of the current block
  private pTrack = new Int8Array(MAX_PENDING);
  private pVel = new Uint8Array(MAX_PENDING);
  private pPitch = new Int16Array(MAX_PENDING);
  private pGate = new Float64Array(MAX_PENDING);
  private held = new Int16Array(MAX_HELD);
  // auditioning a sample from the browser: straight to the output, past every track and effect
  private previews = [new SampleVoice(), new SampleVoice()];

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
    if (!this.inSong) this.clock.bpm = p.bpm;
    this.clock.swing = p.swing;
    const sr = this.sampleRate;
    const nt = Math.min(p.tracks.length, MAX_TRACKS);
    for (let i = 0; i < nt; i++) {
      const s = p.tracks[i].synth;
      const c = this.ch[i];
      const patch = c.patch;
      patch.wave = s.wave < 4 ? s.wave : 4;
      patch.table = s.wave < 4 ? null : this.table(s.wave - 4);
      patch.wave2 = s.wave2 < 4 ? s.wave2 : 4;
      patch.table2 = s.wave2 < 4 ? null : this.table(s.wave2 - 4);
      patch.ratio2 = Math.pow(2, (s.semi2 + s.fine2 / 100) / 12);
      patch.uni = s.uni;
      patch.lfoShape = s.lfoShape;
      patch.lfoDest = s.lfoDest;
      patch.menvDest = s.menvDest;
      patch.menvAttack = 0.001 * Math.pow(2000, s.menvAttack / 127);
      patch.menvDecay = 0.02 * Math.pow(200, s.menvDecay / 127);
      // keep each effect's state while its slot holds the same kind of effect
      const rack = p.tracks[i].fx;
      c.rack = rack;
      for (let k = 0; k < MAX_INSERTS; k++) {
        const type = rack[k]?.type;
        if (!type) { c.inserts[k] = null; c.kinds[k] = ''; }
        else if (c.kinds[k] !== type) { c.inserts[k] = createInsert(type, sr); c.kinds[k] = type; }
      }
      patch.attack = 0.001 * Math.pow(2000, s.attack / 127);
      patch.decayCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.decay / 127) * sr) / 3));
      patch.sustain = s.sustain / 127;
      patch.releaseCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.release / 127) * sr) / 3));
    }
    // timeline lookups, built here so that playing a step allocates nothing
    const a = p.arr;
    this.clips = [];
    for (let t = 0; t < nt; t++) this.clips.push(a.clips.filter((c) => c.track === t).sort((x, y) => x.start - y.start));
    this.end = songEnd(a);
    this.curves = [];
    for (const l of a.lanes) {
      const pi = paramIndex(l.param);
      if (!l.on || !l.points.length || pi < 0 || l.track >= nt) continue;
      this.curves.push({ slot: (l.track < 0 ? MAX_TRACKS : l.track) * NP + pi, track: l.track, points: l.points });
    }
    this.loadValues();
    if (this.automated) this.automate();
  }

  /** Copy every knob from the project into the value array (undoing any automation). */
  private loadValues(): void {
    const p = this.project, v = this.val;
    const nt = Math.min(p.tracks.length, MAX_TRACKS);
    for (let i = 0; i < NP; i++) {
      const d = PARAMS[i];
      if (d.scope === 'master') v[MAX_TRACKS * NP + i] = d.get(p);
      else for (let t = 0; t < nt; t++) v[t * NP + i] = d.get(p.tracks[t]);
    }
    for (let t = 0; t < nt; t++) this.patch(t);
  }

  private patch(t: number): void {
    const v = this.val, o = t * NP, patch = this.ch[t].patch;
    const bp = this.ch[t].bassPatch, dp = this.ch[t].drumPatch, tr = this.project.tracks[t];
    bp.drive = v[o + P_BDRIVE] / 127;
    bp.decay = 0.12 * Math.pow(60, v[o + P_BDECAY] / 127);
    bp.tone = v[o + P_BTONE] / 127;
    bp.glide = v[o + P_BGLIDE] < 0.5 ? 0 : 0.01 * Math.pow(60, v[o + P_BGLIDE] / 127);
    bp.punch = tr.bass.punch / 127;
    dp.model = tr.dsyn.model;
    dp.tune = v[o + P_DTUNE];
    dp.decay = v[o + P_DDECAY] / 127;
    dp.tone = v[o + P_DTONE] / 127;
    dp.snap = v[o + P_DSNAP] / 127;
    patch.cutoff = v[o + P_CUTOFF] / 127;
    patch.reso = v[o + P_RESO] / 127;
    patch.envAmt = v[o + P_ENV] / 127;
    patch.pos = v[o + P_POS] / 127;
    patch.pos2 = v[o + P_POS2] / 127;
    patch.mix = v[o + P_MIX] / 127;
    patch.noise = v[o + P_NOISE] / 127;
    patch.detune = (v[o + P_DETUNE] / 127) * 100;
    patch.spread = v[o + P_SPREAD] / 127;
    patch.lfoAmt = v[o + P_LFOAMT] / 64;
    patch.menvAmt = v[o + P_MENVAMT] / 64;
    const rate = v[o + P_LFORATE];
    patch.lfoHz = this.project.tracks[t].synth.lfoSync
      ? this.clock.bpm / (15 * LFO_DIVS[Math.round((rate / 127) * (LFO_DIVS.length - 1))])
      : 0.05 * Math.pow(600, rate / 127);
  }

  /** Move the automated knobs to where their curves are at the current song position. */
  private automate(): void {
    const cs = this.curves;
    if (!cs.length) return;
    const sps = samplesPerStep(this.clock.bpm, this.sampleRate);
    const frac = this.sinceStep / sps;
    const pos = this.curStep + (frac < 1 ? frac : 1);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      this.val[c.slot] = curveAt(c.points, pos);
      if (c.track >= 0) this.patch(c.track);
    }
  }

  /** Hand over a ready-made wavetable. Until it arrives, an oscillator that wants it plays a sine. */
  setTable(index: number, frames: Float32Array[][]): void {
    this.tables.set(index, { frames });
    this.setProject(this.project);
  }

  private table(index: number): Wavetable | null {
    let t = this.tables.get(index);
    if (!t && this.buildTables) { t = wavetable(index); this.tables.set(index, t); }
    return t ?? null;
  }

  setSample(id: string, l: Float32Array, r?: Float32Array): void {
    this.samples.set(id, { l, r: r ?? l });
  }

  dropSample(id: string): void {
    this.samples.delete(id);
  }

  /**
   * Start from the top. With `chain`, plays those patterns in order (and stops
   * at the end unless `loop`); otherwise follows the project's song/pattern mode.
   */
  play(opts: { chain?: number[]; loop?: boolean; pattern?: number; from?: number; step?: number } = {}): void {
    this.clock.reset();
    // `step` joins a looping pattern part-way through, for a session that is already playing
    this.stepIdx = opts.step ? opts.step % this.project.steps : 0;
    this.clock.phase = this.stepIdx & 1;
    this.songPos = 0;
    this.started = false;
    this.ended = false;
    this.queued = -1;
    this.chain = opts.chain ?? null;
    this.loop = opts.loop ?? true;
    if (opts.pattern !== undefined) this.pattern = opts.pattern;
    if (opts.from !== undefined) this.cue = opts.from;
    if (this.chain) this.pattern = this.chain[0];
    this.inSong = !this.chain && this.project.songMode;
    this.songStep = this.cue;
    this.curStep = this.cue;
    this.sinceStep = 0;
    this.loops = 0;
    this.seed = 0x2f6e2b1; // the same dice every time, so a render can be repeated exactly
    this.pn = 0;
    if (this.inSong) this.clock.phase = (this.cue - barStart(this.project, this.cue)) & 1;
    if (!this.inSong) this.clock.bpm = this.project.bpm;
    this.playing = true;
  }

  /** Jump to a timeline step: right away while the song plays, or as the place the next play() starts from. */
  seek(step: number): void {
    this.cue = step;
    if (this.playing && this.inSong) this.songStep = step;
  }

  stop(): void {
    this.playing = false;
    this.inSong = false;
    this.clock.bpm = this.project.bpm;
    if (this.automated) { this.automated = false; this.loadValues(); }
    this.queued = -1;
    this.pn = 0;
    for (const c of this.ch) {
      for (const v of c.synths) if (v.active && !v.held) v.release();
      if (c.bass.active && !c.bass.held) c.bass.release();
    }
  }

  /** Silence everything right now. */
  panic(): void {
    for (const c of this.ch) {
      for (const v of c.samples) if (v.active) v.kill();
      for (const v of c.synths) if (v.active) v.kill();
      for (const v of c.drums) if (v.active) v.kill();
      if (c.bass.active) c.bass.kill();
    }
  }

  /** Switch pattern: immediately when stopped, on the next bar line when playing. */
  setPattern(i: number): void {
    if (!this.playing || this.inSong) this.pattern = i;
    else this.queued = i === this.pattern && !this.chain ? -1 : i;
  }

  /** Let a sample be heard on its own (the sample browser). An empty id just stops whatever is playing. */
  preview(id: string): void {
    const [a, b] = this.previews;
    if (a.active) a.kill();
    if (b.active) b.kill();
    const data = this.samples.get(id);
    if (!data) return;
    const v = a.active ? b : a;
    if (v.active) return; // both still fading from quick flicks through a list: skip this one
    v.start(data, 1, 0.7, 1, this.age++);
  }

  /** Play a drum hit or a one-shot synth note right away (pads, MIDI, previews). */
  trigger(track: number, vel: number, pitch?: number): void {
    const t = this.project.tracks[track];
    if (!t) return;
    if (t.kind === 'drum') this.hit(track, t, vel);
    else if (t.kind === 'dsyn') this.drum(track, vel);
    else if (t.kind === 'slice') this.hit(track, t, vel, pitch ?? t.note);
    else this.noteOn(track, pitch ?? t.note, vel, this.sampleRate * 0.2);
  }

  noteOn(track: number, pitch: number, vel: number, gateFrames = Infinity): void {
    const c = this.ch[track];
    const tr = this.project.tracks[track];
    if (!c || !tr) return;
    if (tr.kind !== 'synth') {
      // on a sliced sample the "pitch" is the slice number, and it plays for as long as the note
      if (tr.kind === 'slice') this.hit(track, tr, vel, pitch, gateFrames);
      else if (tr.kind === 'bass') {
        // a part written in one key moves with the song when the key changes
        const shift = tr.bass.follow ? ((this.project.scaleRoot - tr.bass.key + 18) % 12) - 6 : 0;
        c.bass.start(pitch + shift, vel, gateFrames, c.bassPatch);
        c.bassNote = pitch;
      }
      return;
    }
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
    if (c.bass.active && c.bass.held && c.bassNote === pitch) c.bass.release();
  }

  /** Start a drum-synth voice. Like a real drum, a new hit cuts the one before short only when the voices run out. */
  private drum(track: number, vel: number): void {
    const c = this.ch[track];
    let v = c.drums[0];
    for (let i = 0; i < c.drums.length; i++) {
      const d = c.drums[i];
      if (!d.active) { v = d; break; }
      if (d.age < v.age) v = d;
    }
    v.start(c.drumPatch, vel, this.age++);
  }

  /** Start a sample voice. With `slice`, only that slice plays, and it cuts off whatever was sounding (like chopping on pads). */
  private hit(track: number, t: Track, vel: number, slice = -1, gate = Infinity): void {
    const data = this.samples.get(t.sample);
    if (!data) return;
    const c = this.ch[track];
    const len = data.l.length;
    let from = 0, to = len;
    if (slice >= 0 && t.slices.length) {
      const i = slice % t.slices.length;
      from = toFrame(t.slices[i], len);
      to = i + 1 < t.slices.length ? toFrame(t.slices[i + 1], len) : len;
      for (let k = 0; k < c.samples.length; k++) if (c.samples[k].active) c.samples[k].kill();
    }
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
    const dk = this.val[track * NP + P_DECAY];
    const decay = dk >= 126.5 ? 1 : Math.exp(-1 / (0.012 * Math.pow(330, dk / 127) * this.sampleRate));
    const st = this.val[track * NP + P_STRETCH];
    const stretch = st > 63.5 && st < 64.5 ? 1 : Math.pow(2, (st - 64) / 32);
    v.start(data, Math.pow(2, this.val[track * NP + P_TUNE] / 12), g * g, decay, this.age++, from, to, t.reverse, stretch, gate);
  }

  private rnd(): number {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  /** Play something `delay` frames after the frame the current step landed on. */
  private at(offset: number, delay: number, track: number, vel: number, pitch: number, gate: number): void {
    if (delay < 0.5) { this.emit(track, vel, pitch, gate); return; }
    if (this.pn === MAX_PENDING) return;
    const i = this.pn++;
    this.pAt[i] = Math.round(offset + delay);
    this.pTrack[i] = track; this.pVel[i] = vel; this.pPitch[i] = pitch; this.pGate[i] = gate;
  }

  private emit(track: number, vel: number, pitch: number, gate: number): void {
    const tr = this.project.tracks[track];
    if (!tr) return;
    if (tr.kind === 'drum') this.hit(track, tr, vel);
    else if (tr.kind === 'dsyn') this.drum(track, vel);
    else this.noteOn(track, pitch, vel, gate);
  }

  /** Render voices up to frame `to` of the block, starting every scheduled hit that is due on the way. */
  private runTo(to: number): void {
    while (this.pn) {
      let k = -1, first = to;
      for (let i = 0; i < this.pn; i++) if (this.pAt[i] < first) { first = this.pAt[i]; k = i; }
      if (k < 0) break;
      if (first > this.from) { this.voices(this.from, first, this.nt); this.from = first; }
      const track = this.pTrack[k], vel = this.pVel[k], pitch = this.pPitch[k], gate = this.pGate[k];
      const last = --this.pn;
      this.pAt[k] = this.pAt[last]; this.pTrack[k] = this.pTrack[last]; this.pVel[k] = this.pVel[last];
      this.pPitch[k] = this.pPitch[last]; this.pGate[k] = this.pGate[last];
      this.emit(track, vel, pitch, gate);
    }
    if (to > this.from) { this.voices(this.from, to, this.nt); this.from = to; }
  }

  /**
   * One track's part of one step. `loop` is how many times its pattern has come round,
   * `pos` the step's place in the bar (for the groove), `left` how many steps may still sound.
   */
  private stepTrack(t: number, tr: Track, pat: Pattern, step: number, loop: number, pos: number, left: number, sps: number, offset: number): void {
    const m = pat.mods?.[t]?.[step] ?? 0;
    if (m) {
      if (!condPass(modCond(m), loop, this.fill)) return;
      const chance = modChance(m);
      if (chance && this.rnd() * 100 >= CHANCES[chance]) return;
    }
    const drum = tr.kind === 'drum' || tr.kind === 'dsyn';
    const arp = !drum && tr.arpMode > 0;
    if (drum && !pat.steps[t]?.[step]) return;
    const notes = pat.notes[t];
    if (!drum && !notes?.length) return;

    const p = this.project;
    const g = tr.groove ? tr.groove : p.groove;
    let delay = 0, scale = 1;
    if (g) {
      const groove = GROOVES[g], amt = (tr.groove ? tr.grooveAmt : p.grooveAmt) / 100;
      delay = groove.delay(pos, amt, this.rnd()) * sps;
      scale = groove.vel(pos, amt, this.rnd());
    }
    const ratchet = m ? modRatchet(m) : 1;

    if (drum) {
      const vel = Math.max(1, Math.round(pat.steps[t][step] * scale));
      // a roll: the hits after the first are a touch softer, the way a stick bounces
      for (let k = 0; k < ratchet; k++) this.at(offset, delay + (k * sps) / ratchet, t, k ? Math.max(1, Math.round(vel * 0.82)) : vel, -1, 0);
      return;
    }
    if (arp) { this.arp(t, tr, notes, step, delay, scale, sps, offset); return; }
    for (let n = 0; n < notes.length; n++) {
      const nt = notes[n];
      if (nt.s !== step) continue;
      const vel = Math.max(1, Math.round(nt.v * scale));
      const len = (nt.l < left ? nt.l : left) * sps;
      if (ratchet === 1) this.at(offset, delay, t, vel, nt.p, Math.max(1, Math.round(len * 0.96)));
      else for (let k = 0; k < ratchet; k++) this.at(offset, delay + (k * sps) / ratchet, t, vel, nt.p, Math.max(1, Math.round((sps / ratchet) * 0.8)));
    }
  }

  /** The arpeggiator: instead of a chord's notes starting together, they are stepped through for as long as the chord lasts. */
  private arp(t: number, tr: Track, notes: Pattern['notes'][number], step: number, delay: number, scale: number, sps: number, offset: number): void {
    const held = this.held;
    let n = 0, start = -1, vel = 0;
    for (let i = 0; i < notes.length; i++) {
      const nt = notes[i];
      if (nt.s > step || step >= nt.s + nt.l) continue;
      if (nt.s > start) start = nt.s; // the newest chord restarts the run
      if (nt.v > vel) vel = nt.v;
      if (n === MAX_HELD) continue;
      let k = n++;
      while (k > 0 && held[k - 1] > nt.p) { held[k] = held[k - 1]; k--; }
      held[k] = nt.p;
    }
    if (!n) return;
    const rate = ARP_RATES[tr.arpRate] ?? 1;
    const total = n * tr.arpOct;
    const gate = Math.max(1, Math.round(rate * sps * (tr.arpGate / 127) * 0.96));
    vel = Math.max(1, Math.round(vel * scale));
    for (let sub = 0; sub < 1; sub += rate < 1 ? rate : 1) {
      const along = step - start + sub;
      if (along % rate !== 0) continue;
      const k = arpIndex(tr.arpMode, Math.round(along / rate), total, tr.arpMode === 4 ? this.rnd() : 0);
      const pitch = held[k % n] + 12 * Math.floor(k / n);
      if (pitch <= 127) this.at(offset, delay + sub * sps, t, vel, pitch, gate);
    }
  }

  /** One step of the timeline: every track plays whatever clip it is inside. */
  private songFire(offset: number): boolean {
    const p = this.project, a = p.arr;
    let s = this.songStep;
    const end = this.end || p.steps;
    const looped = a.loopOn && a.loopEnd > a.loopStart && a.loopStart < end;
    if (s >= end) {
      if (!this.loop) { this.playing = false; this.ended = true; return false; }
      s = looped ? a.loopStart : 0;
    }
    // work out the step after this one now, so swing knows whether it is an off-beat
    let next = s + 1;
    if (this.loop) {
      if (looped && next === a.loopEnd) next = a.loopStart;
      else if (next >= end) next = looped ? a.loopStart : 0;
    }
    this.songStep = next;
    this.curStep = s;
    this.sinceStep = -offset;
    let bpm = p.bpm;
    const tempo = a.tempo;
    for (let i = 0; i < tempo.length && tempo[i].at <= s; i++) bpm = tempo[i].bpm;
    this.clock.bpm = bpm;
    // put the automated knobs where they belong on this step before anything on it plays
    if (this.curves.length) { this.sinceStep = 0; this.automate(); this.sinceStep = -offset; }
    const sps = samplesPerStep(bpm, this.sampleRate);
    const bar = barStart(p, s);
    for (let t = 0; t < this.clips.length; t++) {
      const cl = this.clips[t];
      let c: Clip | null = null;
      for (let i = 0; i < cl.length; i++) {
        if (cl[i].start > s) break;
        if (s < cl[i].start + cl[i].len) { c = cl[i]; break; }
      }
      if (!c) continue;
      const pat = p.patterns[c.pattern];
      if (!pat) continue;
      const along = s - c.start + c.offset;
      // notes are cut where their clip ends
      this.stepTrack(t, p.tracks[t], pat, along % p.steps, Math.floor(along / p.steps), s - bar, c.start + c.len - s, sps, offset);
    }
    if (this.onStep) {
      const info = this.info;
      info.step = s; info.pattern = this.pattern; info.song = s; info.offset = offset;
      this.onStep(info);
    }
    return true;
  }

  private fire = (_globalStep: number, offset: number): void => {
    this.runTo(offset);
    if (!this.playing) return;
    const p = this.project;
    // Moving between pattern and song playback waits for a bar line, so the switch never stumbles.
    const wantSong = !this.chain && p.songMode;
    if (this.inSong && !wantSong) {
      if (this.songStep === barStart(p, this.songStep)) { this.inSong = false; this.stepIdx = 0; this.started = false; this.clock.bpm = p.bpm; this.clock.phase = 1; }
    } else if (!this.inSong && wantSong && (this.stepIdx >= p.steps || this.stepIdx === 0)) {
      this.inSong = true;
      this.songStep = this.cue;
    }
    if (this.inSong) {
      this.automated = this.curves.length > 0;
      // swing follows the position inside the bar, which matters when a bar has an odd number of steps
      if (this.songFire(offset)) this.clock.phase = (this.songStep - barStart(p, this.songStep)) & 1;
      return;
    }
    if (this.automated) { this.automated = false; this.loadValues(); }
    if (this.stepIdx >= p.steps) this.stepIdx = 0;
    if (this.stepIdx === 0 && this.started) {
      const chain = this.chain;
      if (chain) {
        this.songPos++;
        if (this.songPos >= chain.length) {
          if (!this.loop) { this.playing = false; this.ended = true; return; }
          this.songPos = 0;
        }
        this.pattern = chain[this.songPos];
        this.queued = -1;
        this.loops = 0;
      } else if (this.queued >= 0) {
        this.pattern = this.queued;
        this.queued = -1;
        this.loops = 0;
      } else this.loops++;
    }
    this.started = true;
    const step = this.stepIdx++;
    const pat = p.patterns[this.pattern];
    if (pat) {
      const sps = samplesPerStep(p.bpm, this.sampleRate);
      for (let t = 0; t < p.tracks.length; t++) this.stepTrack(t, p.tracks[t], pat, step, this.loops, step, Infinity, sps, offset);
    }
    if (this.onStep) {
      const info = this.info; // reused: nothing on the audio path allocates
      info.step = step; info.pattern = this.pattern; info.song = -1; info.offset = offset;
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
    this.runTo(n);
    for (let i = 0; i < this.pn; i++) this.pAt[i] -= n;
    if (this.automated) { this.sinceStep += n; this.automate(); }
    const val = this.val, mo = MAX_TRACKS * NP;

    const { mixL, mixR, revIn, dlyIn } = this;
    mixL.fill(0, 0, n); mixR.fill(0, 0, n); revIn.fill(0, 0, n); dlyIn.fill(0, 0, n);
    let anySolo = false;
    for (let t = 0; t < nt; t++) if (p.tracks[t].solo) anySolo = true;

    for (let t = 0; t < nt; t++) {
      const tr = p.tracks[t], c = this.ch[t], o = t * NP;
      const rack = c.rack;
      for (let k = 0; k < rack.length; k++) {
        const fx = rack[k], ins = c.inserts[k];
        if (!ins || !fx.on) continue;
        if (fx.type === 'duck') {
          // knob 1 picks whose level does the ducking: 0 = this track, 1..8 = that track
          const src = fx.p[0] > 0 && fx.p[0] <= nt ? this.ch[fx.p[0] - 1] : c;
          ins.process(c.l, c.r, n, fx.p, src.l, src.r);
        } else ins.process(c.l, c.r, n, fx.p);
      }
      c.filter.process(c.l, c.r, n, val[o + P_FILTER] / 64, 0.25);
      const on = this.stem >= 0 ? this.stem === t : anySolo ? tr.solo : !tr.mute;
      const g = on ? volGain(val[o + P_VOL]) : 0;
      const a = ((val[o + P_PAN] / 64 + 1) * Math.PI) / 4;
      const tl = g * Math.cos(a) * Math.SQRT2, trr = g * Math.sin(a) * Math.SQRT2;
      if (c.gl < 0) { c.gl = tl; c.gr = trr; } // first block: no fade-in
      const dl = (tl - c.gl) / n, dr = (trr - c.gr) / n;
      const rs = send(val[o + P_REV]), ds = send(val[o + P_DLY]);
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
    const sps = samplesPerStep(this.clock.bpm, this.sampleRate);
    this.delay.process(dlyIn, mixL, mixR, n, DELAY_DIVS[fx.dlyTime] * sps, (val[mo + P_DLYFB] / 127) * 0.85, send(val[mo + P_DLYLVL]) * 1.2);
    this.reverb.process(revIn, mixL, mixR, n, val[mo + P_REVSIZE] / 127, fx.revDamp / 127, send(val[mo + P_REVLVL]) * 1.6);
    this.masterFilter.process(mixL, mixR, n, val[mo + P_MFILTER] / 64, val[mo + P_MRES] / 127);
    if (fx.compOn && this.stem < 0) {
      this.comp.process(mixL, mixR, n, -(fx.compThresh / 127) * 36, 1 + (fx.compRatio / 127) * 11, (fx.compMakeup / 127) * 18);
    } else {
      this.comp.reduction = 0;
    }
    const mg = volGain(val[mo + P_MASTER]), dm = (mg - this.masterGain) / n;
    let g = this.masterGain, pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      g += dm;
      mixL[i] *= g; mixR[i] *= g;
    }
    this.masterGain = mg;
    for (let i = 0; i < 2; i++) if (this.previews[i].active) this.previews[i].render(mixL, mixR, 0, n);
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
      if (c.bass.active) c.bass.render(c.l, c.r, from, to, c.bassPatch);
      const dr = c.drums;
      for (let i = 0; i < dr.length; i++) if (dr[i].active) dr[i].render(c.l, c.r, from, to);
    }
  }

  resetMeters(): void {
    this.peaks.fill(0);
    this.masterPeakL = this.masterPeakR = 0;
  }
}
