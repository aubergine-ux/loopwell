// The whole instrument as a pure, DOM-free class: sequencer, voices, mixer and
// effects. The AudioWorklet runs it in real time; export and the tests run the
// very same code offline, so what you hear is what you render.

import { barStart, curveAt, songEnd } from './arrange';
import { StepClock, samplesPerStep } from './clock';
import { ARP_RATES, CHANCES, GROOVES, arpIndex, condPass, modChance, modCond, modRatchet } from './creative';
import { Compressor, DjFilter, PingPongDelay, Reverb, softClip } from './dsp/fx';
import { createInsert, type Insert } from './dsp/inserts';
import { MasterChain } from './dsp/master';
import { PerfFx } from './dsp/perf';
import { BassVoice, DrumVoice, emptyBassPatch, emptyDrumPatch, type BassPatch, type DrumPatch } from './dsp/instruments';
import { SampleVoice, SynthVoice, emptyPatch, type SampleData, type SynthPatch } from './dsp/voices';
import { wavetable, type Wavetable } from './dsp/wavetable';
import { PARAMS, paramIndex } from './params';
import { codeInfo, codeKey, compileCode, type CodeLine } from './mini';
import { toFrame } from './slicer';
import { LoudnessMeter } from './loudness';
import { DELAY_DIVS, LFO_DIVS, MAX_BUSES, MAX_INSERTS, MAX_TRACKS, emptyProject, type Clip, type InsertFx, type Pattern, type Project, type Track } from './types';

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
const MAX_OFFS = 128;

export interface StepInfo {
  /** Step of the pattern (pattern mode) or of the song (song mode). */
  step: number;
  pattern: number;
  /** Position on the timeline in steps, or -1 while a single pattern loops. */
  song: number;
  /** Frame offset of this step inside the block being processed. */
  offset: number;
  /** Steps played since play() was pressed. */
  count: number;
}

/** A track of the clip launcher is silent. */
export const LAUNCH_OFF = -2;
/** A track of the clip launcher plays whatever pattern is selected, as it always did. */
export const LAUNCH_FOLLOW = -1;
const LAUNCH_NONE = -3;

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

/** A group's own buffer and effects. */
class BusChannel {
  l = new Float32Array(BLOCK);
  r = new Float32Array(BLOCK);
  inserts: (Insert | null)[] = [];
  kinds: string[] = [];
  g = -1;
}

/** How many channels have a loudness meter: the tracks, the groups, the two returns, and the master. */
export const METER_CHANNELS = MAX_TRACKS + MAX_BUSES + 3;

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
  /** Click on every beat while playing. Live only: a render never has it. */
  metronome = false;
  /** While true, "fill only" steps play and "not in fill" steps rest. */
  fill = false;
  onStep: ((info: StepInfo) => void) | null = null;
  /** Called when what the tracks of a looping pattern are playing changes: a launched clip came in, or the pattern switched. */
  onLaunch: ((tracks: Int8Array, count: number) => void) | null = null;
  /**
   * Notes for tracks that a plugin plays: (track, on, pitch, velocity, frames into the block being made).
   * A pitch of -1 with `on` false means every note on that track should stop.
   */
  onPlug: ((track: number, on: boolean, pitch: number, vel: number, offset: number) => void) | null = null;
  /** The sound plugins send back, a stereo pair per track. It joins the track before its effects, like a voice. */
  ext: ({ l: Float32Array; r: Float32Array } | undefined)[] = [];
  private extPos = 0;
  // live code, compiled: remade only when the text (or what it refers to) changes
  private code: CodeLine[] = [];
  private codeKey = '';
  /** Where the block being made starts, counted from the start of the `process` call: add it to an `onPlug` offset. */
  blockAt = 0;
  private inBlock = false;
  // when the notes sent to plugins should end
  private offN = 0;
  private offAt = new Float64Array(MAX_OFFS);
  private offTrack = new Int8Array(MAX_OFFS);
  private offPitch = new Int16Array(MAX_OFFS);
  /** The clip launcher: which pattern each track loops, LAUNCH_FOLLOW or LAUNCH_OFF. Live only; a render never uses it. */
  readonly launch = new Int8Array(MAX_TRACKS).fill(LAUNCH_FOLLOW);
  private launchNext = new Int8Array(MAX_TRACKS).fill(LAUNCH_NONE);
  private launchQuant = new Uint8Array(MAX_TRACKS);
  private launched = new Int8Array(MAX_TRACKS);
  private count = 0;
  readonly perf: PerfFx;
  readonly mastering: MasterChain;
  /** Hear the mix without the mastering chain, at the loudness it has with it. Live only. */
  compare = false;
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
  /** Peaks of the groups, and of the reverb and delay returns. */
  readonly busPeaks = new Float32Array(MAX_BUSES);
  readonly retPeaks = new Float32Array(2);
  /** Loudness meters, made the first time metering is switched on (they cost a little, so a render does without). */
  private meters: LoudnessMeter[] | null = null;
  private bus: BusChannel[] = [];
  private tmpL = new Float32Array(BLOCK);
  private tmpR = new Float32Array(BLOCK);
  private retGain = new Float32Array(2).fill(-1);

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
  private info: StepInfo = { step: 0, pattern: 0, song: -1, offset: 0, count: 0 };
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
  /** Count-in steps still to go before the beat starts. */
  private pre = 0;
  private preTotal = 0;
  /** Loop only these steps of the pattern (the whole of it when `to` is not past `from`). */
  private rangeFrom = 0;
  private rangeTo = 0;
  private clickAt = 0; private clickPh = 0; private clickEnv = 0; private clickHz = 1000;
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
    for (let i = 0; i < MAX_BUSES; i++) this.bus.push(new BusChannel());
    this.reverb = new Reverb(sampleRate);
    this.delay = new PingPongDelay(sampleRate);
    this.masterFilter = new DjFilter(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.perf = new PerfFx(sampleRate);
    this.mastering = new MasterChain(sampleRate);
    this.setProject(this.project);
  }

  get compReduction(): number {
    return this.comp.reduction;
  }

  setProject(p: Project): void {
    this.project = p;
    if (p.code) {
      const key = codeKey(p.code, p);
      if (key !== this.codeKey) { this.codeKey = key; this.code = compileCode(p.code, codeInfo(p), this.code); }
    } else if (this.codeKey) { this.codeKey = ''; this.code = []; }
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
        c.inserts[k]?.setKey?.(p.scaleRoot, p.scaleType);
      }
      patch.attack = 0.001 * Math.pow(2000, s.attack / 127);
      patch.decayCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.decay / 127) * sr) / 3));
      patch.sustain = s.sustain / 127;
      patch.releaseCoef = Math.exp(-1 / ((0.02 * Math.pow(200, s.release / 127) * sr) / 3));
    }
    for (let k = 0; k < MAX_BUSES; k++) {
      const c = this.bus[k], rack = p.buses[k]?.fx ?? [];
      for (let j = 0; j < MAX_INSERTS; j++) {
        const type = rack[j]?.type;
        if (!type) { c.inserts[j] = null; c.kinds[j] = ''; }
        else if (c.kinds[j] !== type) { c.inserts[j] = createInsert(type, sr); c.kinds[j] = type; }
        c.inserts[j]?.setKey?.(p.scaleRoot, p.scaleType);
      }
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
  play(opts: { chain?: number[]; loop?: boolean; pattern?: number; from?: number; step?: number; countIn?: number } = {}): void {
    this.clock.reset();
    this.pre = this.preTotal = Math.max(0, Math.round(opts.countIn ?? 0));
    // `step` joins a looping pattern part-way through, for a session that is already playing
    this.stepIdx = opts.step ? opts.step % this.project.steps : opts.chain ? 0 : this.loopFrom();
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
    this.count = this.stepIdx; // so the count and the pattern stay in step when joining part-way through
    this.seed = 0x2f6e2b1; // the same dice every time, so a render can be repeated exactly
    this.pn = 0;
    if (this.inSong) this.clock.phase = (this.cue - barStart(this.project, this.cue)) & 1;
    if (!this.inSong) this.clock.bpm = this.project.bpm;
    this.playing = true;
  }

  /** Loop steps `from` up to (not including) `to` of the pattern instead of all of it. Pass 0, 0 for the whole pattern. */
  setRange(from: number, to: number): void {
    this.rangeFrom = to > from ? Math.max(0, from) : 0;
    this.rangeTo = to > from ? to : 0;
  }

  private loopFrom(): number {
    return this.rangeTo > this.rangeFrom && this.rangeFrom < this.project.steps ? this.rangeFrom : 0;
  }

  private loopTo(): number {
    const steps = this.project.steps;
    return this.rangeTo > this.rangeFrom && this.rangeFrom < steps ? Math.min(steps, this.rangeTo) : steps;
  }

  private click(accent: boolean, offset: number): void {
    this.clickAt = offset;
    this.clickPh = 0;
    this.clickEnv = accent ? 0.5 : 0.32;
    this.clickHz = accent ? 1760 : 1175;
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
    this.pre = 0;
    this.plugQuiet();
    for (const c of this.ch) {
      for (const v of c.synths) if (v.active && !v.held) v.release();
      if (c.bass.active && !c.bass.held) c.bass.release();
    }
  }

  /** Silence everything right now. */
  panic(): void {
    this.plugQuiet();
    for (const c of this.ch) {
      for (const v of c.samples) if (v.active) v.kill();
      for (const v of c.synths) if (v.active) v.kill();
      for (const v of c.drums) if (v.active) v.kill();
      if (c.bass.active) c.bass.kill();
    }
  }

  /**
   * The clip launcher. Put `pattern` (or LAUNCH_OFF, or LAUNCH_FOLLOW) on a track of the looping pattern.
   * While playing it comes in on the next multiple of `quant` steps (0 = right now), so launches land in time.
   */
  launchClip(track: number, pattern: number, quant: number): void {
    if (track < 0 || track >= MAX_TRACKS) return;
    if (!this.playing || this.inSong || quant <= 0) {
      this.launch[track] = pattern;
      this.launchNext[track] = LAUNCH_NONE;
      this.tellLaunch();
    } else {
      this.launchNext[track] = pattern;
      this.launchQuant[track] = quant;
    }
  }

  private tellLaunch(): void {
    if (!this.onLaunch) return;
    const out = this.launched;
    for (let t = 0; t < MAX_TRACKS; t++) out[t] = this.launch[t] === LAUNCH_FOLLOW ? this.pattern : this.launch[t];
    this.onLaunch(out, this.count);
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

  /** Stop every note a plugin is holding. */
  private plugQuiet(): void {
    this.offN = 0;
    if (!this.onPlug) return;
    const tr = this.project.tracks;
    for (let t = 0; t < tr.length && t < MAX_TRACKS; t++) if (tr[t].kind === 'plugin') this.onPlug(t, false, -1, 0, 0);
  }

  /** Hand a note to the plugin on a track, and remember when it should end. */
  private plugOn(track: number, pitch: number, vel: number, gate: number): void {
    const at = this.inBlock ? this.from : 0;
    if (this.onPlug) this.onPlug(track, true, pitch, vel, at);
    if (gate === Infinity) return;
    if (this.offN === MAX_OFFS) {
      // more notes ringing than there is room to remember: end the oldest now
      if (this.onPlug) this.onPlug(this.offTrack[0], false, this.offPitch[0], 0, at);
      this.offAt.copyWithin(0, 1); this.offTrack.copyWithin(0, 1); this.offPitch.copyWithin(0, 1);
      this.offN--;
    }
    const k = this.offN++;
    this.offAt[k] = at + gate; this.offTrack[k] = track; this.offPitch[k] = pitch;
  }

  /** End the plugin notes that are due within the `n` frames just made. */
  private plugOffs(n: number): void {
    let keep = 0;
    for (let i = 0; i < this.offN; i++) {
      if (this.offAt[i] < n) {
        if (this.onPlug) this.onPlug(this.offTrack[i], false, this.offPitch[i], 0, Math.max(0, Math.floor(this.offAt[i])));
        continue;
      }
      this.offAt[keep] = this.offAt[i] - n; this.offTrack[keep] = this.offTrack[i]; this.offPitch[keep] = this.offPitch[i];
      keep++;
    }
    this.offN = keep;
  }

  noteOn(track: number, pitch: number, vel: number, gateFrames = Infinity): void {
    const c = this.ch[track];
    const tr = this.project.tracks[track];
    if (!c || !tr) return;
    if (tr.kind !== 'synth') {
      // on a sliced sample the "pitch" is the slice number, and it plays for as long as the note
      if (tr.kind === 'slice') this.hit(track, tr, vel, pitch, gateFrames);
      else if (tr.kind === 'plugin') this.plugOn(track, pitch, vel, gateFrames);
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
    if (this.project.tracks[track]?.kind === 'plugin') { if (this.onPlug) this.onPlug(track, false, pitch, 0, this.inBlock ? this.from : 0); return; }
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

  /** Start the live-code hits that fall inside this step. `cyc` counts bars, for patterns that change from bar to bar. */
  private codeStep(step: number, cyc: number, sps: number, offset: number): void {
    const lines = this.code, steps = this.project.steps;
    const lo = step / steps - 1e-9, hi = (step + 1) / steps - 1e-9;
    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k];
      if (!ln.cycles.length || ln.track >= this.project.tracks.length) continue;
      const c = ln.cycles[cyc % ln.cycles.length], t = c.t;
      for (let i = 0; i < t.length; i++) {
        if (t[i] < lo) continue;
        if (t[i] >= hi) break;
        const delay = (t[i] * steps - step) * sps;
        this.at(offset, delay > 0 ? delay : 0, ln.track, c.v[i], c.p[i], Math.max(64, c.d[i] * steps * sps * 0.96));
      }
    }
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
    if (p.codeOn && this.code.length && s - bar < p.steps) this.codeStep(s - bar, Math.floor(bar / p.steps), sps, offset);
    if (this.metronome && (s - bar) % 4 === 0) this.click(s === bar, offset);
    if (this.onStep) {
      const info = this.info;
      info.step = s; info.pattern = this.pattern; info.song = s; info.offset = offset; info.count = this.count++;
      this.onStep(info);
    }
    return true;
  }

  private fire = (_globalStep: number, offset: number): void => {
    this.runTo(offset);
    if (!this.playing) return;
    const p = this.project;
    if (this.pre > 0) {
      // the count-in: clicks on the beat and nothing else, for as many steps as were asked for
      const k = this.preTotal - this.pre;
      if (k % 4 === 0) this.click(k % 16 === 0, offset);
      if (this.onStep) {
        const info = this.info;
        info.step = 0; info.pattern = this.pattern; info.song = -1; info.offset = offset; info.count = -this.pre;
        this.onStep(info);
      }
      this.pre--;
      return;
    }
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
    // a chain (an export, a preview) always plays whole patterns; the loop range is for building a beat
    const from = this.chain ? 0 : this.loopFrom(), to = this.chain ? p.steps : this.loopTo();
    if (this.stepIdx >= to || this.stepIdx < from) this.stepIdx = from;
    if (this.stepIdx === from && this.started) {
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
    const first = !this.started;
    this.started = true;
    const step = this.stepIdx++;
    // launched clips come in when the count reaches their quantize line
    let changed = first || this.pattern !== this.info.pattern;
    for (let t = 0; t < MAX_TRACKS; t++) {
      if (this.launchNext[t] === LAUNCH_NONE || this.count % this.launchQuant[t]) continue;
      this.launch[t] = this.launchNext[t];
      this.launchNext[t] = LAUNCH_NONE;
      changed = true;
    }
    this.info.pattern = this.pattern;
    if (changed) this.tellLaunch();
    if (this.metronome && step % 4 === 0) this.click(step % 16 === 0, offset);
    const sps = samplesPerStep(p.bpm, this.sampleRate);
    for (let t = 0; t < p.tracks.length; t++) {
      const which = this.launch[t];
      if (which === LAUNCH_OFF) continue;
      const pat = p.patterns[which === LAUNCH_FOLLOW ? this.pattern : which];
      if (pat) this.stepTrack(t, p.tracks[t], pat, step, this.loops, step, Infinity, sps, offset);
    }
    if (p.codeOn && this.code.length) this.codeStep(step, this.chain ? this.songPos : this.loops, sps, offset);
    if (this.onStep) {
      const info = this.info; // reused: nothing on the audio path allocates
      info.step = step; info.pattern = this.pattern; info.song = -1; info.offset = offset; info.count = this.count;
      this.onStep(info);
    }
    this.count++;
  };

  /** Render `frames` of stereo audio. Any length; split into 128-frame blocks inside. */
  process(outL: Float32Array, outR: Float32Array, frames: number, start = 0, extAt = 0): void {
    for (let done = 0; done < frames; done += BLOCK) {
      const n = Math.min(BLOCK, frames - done);
      this.extPos = extAt + done;
      this.blockAt = done;
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
    this.inBlock = true;
    if (this.playing) this.clock.advance(n, this.fire);
    this.runTo(n);
    this.inBlock = false;
    for (let i = 0; i < this.pn; i++) this.pAt[i] -= n;
    if (this.offN) this.plugOffs(n);
    if (this.automated) { this.sinceStep += n; this.automate(); }
    const val = this.val, mo = MAX_TRACKS * NP;

    const { mixL, mixR, revIn, dlyIn, tmpL, tmpR } = this;
    mixL.fill(0, 0, n); mixR.fill(0, 0, n); revIn.fill(0, 0, n); dlyIn.fill(0, 0, n);
    let anySolo = false;
    for (let t = 0; t < nt; t++) if (p.tracks[t].solo) anySolo = true;
    const nb = Math.min(p.buses.length, MAX_BUSES);
    for (let k = 0; k < nb; k++) { this.bus[k].l.fill(0, 0, n); this.bus[k].r.fill(0, 0, n); }
    const meters = this.meters;

    for (let t = 0; t < nt; t++) {
      const tr = p.tracks[t], c = this.ch[t], o = t * NP;
      const ex = this.ext[t];
      if (ex && tr.kind === 'plugin') {
        const at = this.extPos, m = Math.min(n, ex.l.length - at);
        for (let i = 0; i < m; i++) { c.l[i] += ex.l[at + i]; c.r[i] += ex.r[at + i]; }
      }
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
      // a track goes to its group if it has one, otherwise straight to the mix
      const to = tr.bus > 0 && tr.bus <= nb ? this.bus[tr.bus - 1] : null;
      const outL = to ? to.l : mixL, outR = to ? to.r : mixR;
      for (let i = 0; i < n; i++) {
        gl += dl; gr += dr;
        const l = L[i] * gl, r = R[i] * gr;
        outL[i] += l; outR[i] += r;
        tmpL[i] = l; tmpR[i] = r;
        const m = (l + r) * 0.5;
        revIn[i] += m * rs; dlyIn[i] += m * ds;
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
      }
      c.gl = tl; c.gr = trr;
      if (peak > this.peaks[t]) this.peaks[t] = peak;
      if (meters) meters[t].process(tmpL, tmpR, n);
    }

    // groups: everything sent to one goes through its effects together
    for (let k = 0; k < nb; k++) {
      const b = p.buses[k], c = this.bus[k];
      for (let j = 0; j < b.fx.length; j++) {
        const fx = b.fx[j], ins = c.inserts[j];
        if (!ins || !fx.on) continue;
        if (fx.type === 'duck') {
          const src = fx.p[0] > 0 && fx.p[0] <= nt ? this.ch[fx.p[0] - 1] : c;
          ins.process(c.l, c.r, n, fx.p, src.l, src.r);
        } else ins.process(c.l, c.r, n, fx.p);
      }
      const target = b.mute ? 0 : volGain(b.vol);
      if (c.g < 0) c.g = target;
      const dg = (target - c.g) / n;
      let g = c.g, peak = 0;
      const L = c.l, R = c.r;
      for (let i = 0; i < n; i++) {
        g += dg;
        const l = L[i] * g, r = R[i] * g;
        L[i] = l; R[i] = r;
        mixL[i] += l; mixR[i] += r;
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
      }
      c.g = target;
      if (peak > this.busPeaks[k]) this.busPeaks[k] = peak;
      if (meters) meters[MAX_TRACKS + k].process(L, R, n);
    }

    const fx = p.fx;
    const sps = samplesPerStep(this.clock.bpm, this.sampleRate);
    const room = this.perf.throwSend(mixL, mixR, revIn, n);
    // the two returns are channels of their own: each is made on its own, metered, and then joins the mix
    tmpL.fill(0, 0, n); tmpR.fill(0, 0, n);
    this.delay.process(dlyIn, tmpL, tmpR, n, DELAY_DIVS[fx.dlyTime] * sps, (val[mo + P_DLYFB] / 127) * 0.85, send(val[mo + P_DLYLVL]) * 1.2);
    this.retPeaks[1] = Math.max(this.retPeaks[1], this.join(tmpL, tmpR, n, fx.dlyMute, 1));
    if (meters) meters[MAX_TRACKS + MAX_BUSES + 1].process(tmpL, tmpR, n);
    tmpL.fill(0, 0, n); tmpR.fill(0, 0, n);
    // a throw wants a big, loud room whatever the reverb knobs say
    const size = val[mo + P_REVSIZE] / 127, level = send(val[mo + P_REVLVL]) * 1.6;
    this.reverb.process(revIn, tmpL, tmpR, n, room > 0 ? Math.max(size, 0.6 + room * 0.4) : size, fx.revDamp / 127, room > 0 ? Math.max(level, 1.2) : level);
    this.retPeaks[0] = Math.max(this.retPeaks[0], this.join(tmpL, tmpR, n, fx.revMute, 0));
    if (meters) meters[MAX_TRACKS + MAX_BUSES].process(tmpL, tmpR, n);
    this.masterFilter.process(mixL, mixR, n, val[mo + P_MFILTER] / 64, val[mo + P_MRES] / 127);
    this.perf.process(mixL, mixR, n, sps);
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
    // with the mastering chain on, its limiter is what keeps the level in bounds; without it, the soft clipper does
    const mastered = p.mastering.on && this.stem < 0;
    if (mastered) this.mastering.process(mixL, mixR, n, p.mastering, this.compare);
    for (let i = 0; i < 2; i++) if (this.previews[i].active) this.previews[i].render(mixL, mixR, 0, n);
    if (this.clickEnv > 1e-4) {
      // the metronome: a short blip, after the master so no effect touches it
      const w = (2 * Math.PI * this.clickHz) / this.sampleRate, decay = Math.exp(-1 / (0.012 * this.sampleRate));
      let ph = this.clickPh, env = this.clickEnv;
      for (let i = this.clickAt; i < n; i++) {
        const x = Math.sin(ph) * env;
        mixL[i] += x; mixR[i] += x;
        ph += w; env *= decay;
        if (env < 1e-4) { env = 0; break; } // stop on the sample it dies away, not at the end of the block
      }
      this.clickPh = ph; this.clickEnv = env; this.clickAt = 0;
    }
    if (mastered) {
      for (let i = 0; i < n; i++) { const a = mixL[i], b = mixR[i]; if (a > 1) mixL[i] = 1; else if (a < -1) mixL[i] = -1; if (b > 1) mixR[i] = 1; else if (b < -1) mixR[i] = -1; }
    } else {
      softClip(mixL, n);
      softClip(mixR, n);
    }
    for (let i = 0; i < n; i++) {
      const al = Math.abs(mixL[i]), ar = Math.abs(mixR[i]);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    if (meters) meters[METER_CHANNELS - 1].process(mixL, mixR, n);
    if (pl > this.masterPeakL) this.masterPeakL = pl;
    if (pr > this.masterPeakR) this.masterPeakR = pr;
  }

  /** Add a return to the mix (or not, if it is muted), easing its level so a mute never clicks. Returns its peak. */
  private join(L: Float32Array, R: Float32Array, n: number, mute: boolean, which: number): number {
    const target = mute ? 0 : 1;
    if (this.retGain[which] < 0) this.retGain[which] = target;
    let g = this.retGain[which], peak = 0;
    const dg = (target - g) / n;
    const { mixL, mixR } = this;
    for (let i = 0; i < n; i++) {
      g += dg;
      const l = L[i] * g, r = R[i] * g;
      L[i] = l; R[i] = r;
      mixL[i] += l; mixR[i] += r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
    }
    this.retGain[which] = target;
    return peak;
  }

  /** Switch the loudness meters on or off. They only run while something is looking at them. */
  setMetering(on: boolean): void {
    if (!on) { this.meters = null; return; }
    if (this.meters) return;
    this.meters = [];
    for (let i = 0; i < METER_CHANNELS; i++) this.meters.push(new LoudnessMeter(this.sampleRate, i === METER_CHANNELS - 1));
  }

  /** Momentary loudness of every channel into `out` (tracks, groups, reverb, delay, master), then the master's short-term and integrated. */
  readLoudness(out: Float32Array): boolean {
    const m = this.meters;
    if (!m) return false;
    for (let i = 0; i < METER_CHANNELS; i++) out[i] = m[i].momentary;
    out[METER_CHANNELS] = m[METER_CHANNELS - 1].shortTerm;
    out[METER_CHANNELS + 1] = m[METER_CHANNELS - 1].integrated;
    return true;
  }

  /** Start the master's integrated reading again (it otherwise runs from when metering was switched on). */
  resetLoudness(): void {
    this.meters?.[METER_CHANNELS - 1].reset();
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
    this.busPeaks.fill(0);
    this.retPeaks.fill(0);
    this.masterPeakL = this.masterPeakR = 0;
  }
}
