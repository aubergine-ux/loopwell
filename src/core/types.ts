// The project model. Every knob value is a small integer (mostly 0..127, like
// MIDI CCs) so beats round-trip exactly through the share-link codec.

import { INSERTS, INSERT_TYPES, type InsertType } from './dsp/inserts';
import { DRUM_MODELS } from './dsp/instruments';
import { MAX_UNISON, MOD_DESTS } from './dsp/voices';
import { WAVETABLES } from './dsp/wavetable';
import { ARP_MODES, ARP_RATES, GROOVES, MAX_ARP_OCT, MAX_MOD } from './creative';
import { PARAMS } from './params';
import { MAX_SLICES } from './slicer';

export const MAX_TRACKS = 8;
export const NUM_PATTERNS = 8;
export const PATTERN_NAMES = 'ABCDEFGH';
export const MAX_STEPS = 32;
export const DEFAULT_VEL = 100;
/** Longest song, in 16th-note steps (about 17 minutes at 120 bpm). */
export const MAX_SONG_STEPS = 8192;
export const MAX_CLIPS = 512;
export const MAX_LANES = 32;
export const MAX_POINTS = 512;
export const MAX_EVENTS = 64;
export const MAX_LYRICS = 200;

/**
 * drum: a one-shot sample on steps. synth: notes. slice: a chopped sample, played by notes whose pitch is the slice number.
 * bass: the 808, one voice played by notes. dsyn: a drum made from knobs instead of a sample, on steps.
 */
export type TrackKind = 'drum' | 'synth' | 'slice' | 'bass' | 'dsyn';
export const TRACK_KINDS: TrackKind[] = ['drum', 'synth', 'slice', 'bass', 'dsyn'];
export const MAX_INSERTS = 5;
export const MAX_BUSES = 4;
/** Classic shapes, then one entry per wavetable. */
export const NUM_WAVES = 4 + WAVETABLES.length;
/** Tempo-synced LFO lengths, in 16th-note steps. */
export const LFO_DIVS = [64, 32, 16, 8, 4, 2, 4 / 3, 1, 2 / 3, 0.5];
export const LFO_DIV_LABELS = ['4 bars', '2 bars', '1 bar', '1/2', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw', 'Square', 'Random'];

/** An effect in a track's rack. `p` holds its four knobs. */
export interface InsertFx {
  type: InsertType;
  on: boolean;
  p: number[];
}

export interface SynthParams {
  wave: number; // 0 saw, 1 square, 2 triangle, 3 sine, 4+ = a wavetable
  pos: number; // where along the wavetable
  wave2: number; // second oscillator
  pos2: number;
  semi2: number; // -24..24 semitones
  fine2: number; // -50..50 cents
  mix: number; // 0 = oscillator 1 only, 127 = oscillator 2 only
  noise: number;
  uni: number; // 1..5 stacked voices
  detune: number; // spread of the stack, 127 = a semitone
  spread: number; // stereo width of the stack
  cutoff: number;
  reso: number;
  env: number; // filter envelope amount
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  lfoShape: number;
  lfoRate: number; // free: 0.05..30 Hz. synced: an index into LFO_DIVS spread over 0..127
  lfoSync: boolean;
  lfoAmt: number; // -64..63
  lfoDest: number; // index into MOD_DESTS
  menvAttack: number;
  menvDecay: number;
  menvAmt: number; // -64..63
  menvDest: number;
}

/** A group: tracks sent to it are mixed together, go through its effects as one, and then on to the master. */
export interface Bus {
  name: string;
  vol: number; // 100 = unity
  mute: boolean;
  fx: InsertFx[];
}

/** The 808 bass. */
export interface BassParams {
  glide: number; // 0 = off; otherwise overlapping notes slide into each other, this slowly
  drive: number; // saturation
  decay: number; // how long a held note rings
  tone: number; // brightness of the saturation
  punch: number; // pitch drop at the start of a note
  follow: boolean; // move the whole part when the song's key changes
  key: number; // 0..11, the key the part was written in
}

/** The drum synth. What tone and snap do depends on the model. */
export interface DrumSynthParams {
  model: number; // index into DRUM_MODELS
  tune: number; // semitones, -24..24
  decay: number;
  tone: number;
  snap: number;
}

export interface Track {
  name: string;
  kind: TrackKind;
  color: number; // 0..7, index into the theme's track palette
  sample: string; // "kit/slot" for built-ins, "user/<id>" for dropped files
  tune: number; // semitones, -24..24
  decay: number; // 127 = play the whole sample
  reverse: boolean;
  stretch: number; // 64 = off; otherwise the sample is made longer or shorter (0.25x..4x) without changing pitch
  slices: number[]; // slice starts as 0..65535 fractions of the sample; used by slice tracks
  fx: InsertFx[];
  synth: SynthParams;
  bass: BassParams;
  dsyn: DrumSynthParams;
  note: number; // MIDI pitch used when a synth track is toggled from the step grid / pads
  vol: number; // 100 = unity
  pan: number; // -64..63
  mute: boolean;
  solo: boolean;
  filter: number; // -64..63, negative = low-pass, positive = high-pass
  rev: number;
  dly: number;
  groove: number; // 0 = follow the song's groove, otherwise an index into GROOVES
  grooveAmt: number; // 0..100
  arpMode: number; // index into ARP_MODES, 0 = off
  arpRate: number; // index into ARP_RATES
  arpOct: number; // 1..3 octaves
  arpGate: number; // note length, 127 = the whole arp step
  bus: number; // 0 = straight to the master, otherwise 1 + an index into project.buses
}

export interface Note {
  s: number; // start step
  l: number; // length in steps
  p: number; // MIDI pitch
  v: number; // velocity 1..127
}

export interface Pattern {
  steps: number[][]; // [track][step] velocity, 0 = off (drum tracks)
  notes: Note[][]; // [track] (synth tracks)
  mods: number[][]; // [track][step] chance, condition and ratchet packed as in creative.ts; 0 = a plain step
}

export interface Fx {
  revSize: number;
  revDamp: number;
  revLevel: number;
  dlyTime: number; // index into DELAY_DIVS
  dlyFb: number;
  dlyLevel: number;
  filter: number; // master DJ filter, -64..63
  filterRes: number;
  compOn: boolean;
  compThresh: number;
  compRatio: number;
  compMakeup: number;
  revMute: boolean; // the reverb and delay returns can be silenced like any channel
  dlyMute: boolean;
}

/** A pattern placed on a track of the timeline. All times are in 16th-note steps. */
export interface Clip {
  id: string;
  track: number;
  pattern: number;
  start: number;
  len: number; // longer than the pattern = the pattern loops inside the clip
  offset: number; // step of the pattern the clip starts on
}

export interface AutoPoint {
  t: number; // step
  v: number; // in the parameter's own range
}

/** A drawn curve that moves one knob while the song plays. */
export interface AutoLane {
  id: string;
  track: number; // -1 = master
  param: string; // id from PARAMS
  on: boolean;
  points: AutoPoint[]; // sorted by t, joined by straight lines
}

/** The mastering chain on the whole mix. Knobs are 0..127 with 64 in the middle meaning "unchanged". */
export interface Mastering {
  on: boolean;
  low: number; // EQ
  mid: number;
  high: number;
  glue: number; // multiband compression, 0 = none
  width: number; // stereo width
  gain: number; // drive into the limiter; the assistant sets this to reach the target
  target: number; // loudness to aim for in LUFS below zero (14 = -14 LUFS), 0 = none chosen
}

export const defaultMastering = (): Mastering => ({ on: false, low: 64, mid: 64, high: 64, glue: 40, width: 64, gain: 64, target: 14 });

/** A line of lyrics, and the step of the song it is sung on. */
export interface LyricLine { at: number; text: string }

export interface TempoEvent { at: number; bpm: number }
export interface SigEvent { at: number; num: number; den: number }
export interface Marker { at: number; name: string; color: number }

export interface Arrangement {
  clips: Clip[];
  lanes: AutoLane[];
  tempo: TempoEvent[]; // changes after the start; the song begins at project.bpm
  sigs: SigEvent[]; // the song begins in 4/4 unless there is an event at 0
  markers: Marker[];
  loopOn: boolean;
  loopStart: number;
  loopEnd: number;
}

export interface Project {
  v: 2;
  name: string;
  bpm: number; // 40..240
  swing: number; // 0..100
  groove: number; // index into GROOVES, for every track that doesn't pick its own
  grooveAmt: number; // 0..100
  steps: 16 | 32;
  tracks: Track[];
  buses: Bus[];
  patterns: Pattern[];
  arr: Arrangement;
  /** false: loop the current pattern. true: play the timeline. */
  songMode: boolean;
  scaleRoot: number; // 0..11
  scaleType: number; // index into SCALES
  scaleLock: boolean;
  fx: Fx;
  master: number; // 100 = unity
  lyrics: LyricLine[]; // sorted by `at`
  mastering: Mastering;
}

/** Delay times in 16th-note steps. */
export const DELAY_DIVS = [1, 4 / 3, 2, 3, 4, 6];
export const DELAY_LABELS = ['1/16', '1/8T', '1/8', '1/8D', '1/4', '1/4D'];
export const WAVES = ['SAW', 'SQR', 'TRI', 'SIN'];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const int = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : d;

/** The newer synth settings, at values that leave a sound exactly as the first synth made it. */
export function synthExtras(wave: number) {
  return {
    pos: 0, wave2: 0, pos2: 0, semi2: 0, fine2: 0, mix: 0, noise: 0,
    // saw and square always were two slightly detuned oscillators
    uni: wave < 2 ? 2 : 1, detune: 9, spread: 0,
    lfoShape: 0, lfoRate: 64, lfoSync: false, lfoAmt: 0, lfoDest: 0,
    menvAttack: 0, menvDecay: 50, menvAmt: 0, menvDest: 0,
  };
}

/** Fill in a synth from a few settings; everything else gets its neutral value. */
export function synth(part: Partial<SynthParams> = {}): SynthParams {
  const wave = part.wave ?? 0;
  return { wave, cutoff: 70, reso: 30, env: 60, attack: 0, decay: 50, sustain: 40, release: 30, ...synthExtras(wave), ...part };
}

export function defaultSynth(): SynthParams {
  return synth();
}

export const defaultBass = (): BassParams => ({ glide: 40, drive: 45, decay: 90, tone: 50, punch: 40, follow: true, key: 0 });

/** Starting points for each drum model, so switching model gives something that already sounds like that drum. */
export const DRUM_DEFAULTS: Omit<DrumSynthParams, 'model'>[] = [
  { tune: 0, decay: 60, tone: 20, snap: 55 },
  { tune: 0, decay: 50, tone: 60, snap: 64 },
  { tune: 0, decay: 25, tone: 64, snap: 40 },
  { tune: 0, decay: 50, tone: 50, snap: 50 },
];
export const defaultDsyn = (model = 0): DrumSynthParams => ({ model, ...DRUM_DEFAULTS[model] });

export function newInsert(type: InsertType): InsertFx {
  return { type, on: true, p: INSERTS[type].knobs.map((k) => k.def) };
}

/** Does this kind of track keep its part as notes (rather than a row of steps)? */
export const usesNotes = (kind: TrackKind) => kind !== 'drum' && kind !== 'dsyn';
/** Does this kind of track play a sample? */
export const usesSample = (kind: TrackKind) => kind === 'drum' || kind === 'slice';
/** Is it played by pitched notes (so scales, chords and keyboards make sense)? */
export const isPitched = (kind: TrackKind) => kind === 'synth' || kind === 'bass';

export function newTrack(kind: TrackKind, color: number, name: string, sample = 'boom/kick'): Track {
  return {
    name, kind, color, sample,
    tune: 0, decay: 127, reverse: false, stretch: 64, slices: [], fx: [],
    synth: defaultSynth(), bass: defaultBass(), dsyn: defaultDsyn(), note: kind === 'bass' ? 36 : 48,
    vol: 100, pan: 0, mute: false, solo: false,
    filter: 0, rev: 0, dly: 0,
    groove: 0, grooveAmt: 50, arpMode: 0, arpRate: 2, arpOct: 1, arpGate: 100, bus: 0,
  };
}

export function newPattern(tracks: number): Pattern {
  return {
    steps: Array.from({ length: tracks }, () => new Array<number>(MAX_STEPS).fill(0)),
    notes: Array.from({ length: tracks }, () => [] as Note[]),
    mods: Array.from({ length: tracks }, () => new Array<number>(MAX_STEPS).fill(0)),
  };
}

export function defaultFx(): Fx {
  return {
    revSize: 70, revDamp: 60, revLevel: 90,
    dlyTime: 3, dlyFb: 50, dlyLevel: 90,
    filter: 0, filterRes: 30,
    compOn: true, compThresh: 40, compRatio: 40, compMakeup: 20,
    revMute: false, dlyMute: false,
  };
}

export function defaultTracks(kit = 'boom'): Track[] {
  const t = [
    newTrack('drum', 0, 'KICK', `${kit}/kick`),
    newTrack('drum', 1, 'SNARE', `${kit}/snare`),
    newTrack('drum', 2, 'CLAP', `${kit}/clap`),
    newTrack('drum', 3, 'HAT', `${kit}/hat`),
    newTrack('drum', 4, 'OPEN', `${kit}/open`),
    newTrack('drum', 5, 'PERC', `${kit}/perc`),
    newTrack('synth', 6, 'BASS'),
    newTrack('synth', 7, 'LEAD'),
  ];
  t[3].vol = 80;
  t[4].vol = 75;
  t[6].note = 36;
  t[6].synth = synth({ wave: 0, cutoff: 46, reso: 40, env: 70, attack: 0, decay: 46, sustain: 30, release: 20 });
  t[7].note = 60;
  t[7].synth = synth({ wave: 1, cutoff: 78, reso: 24, env: 40, attack: 2, decay: 60, sustain: 50, release: 50 });
  t[7].vol = 80;
  t[7].dly = 50;
  t[7].rev = 40;
  return t;
}

let idSeq = 0;
/** Short id for clips and lanes. Only has to be unique inside one project. */
export function newId(): string {
  return (idSeq++).toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
}

/** One clip per track for each entry of a pattern chain; runs of the same pattern become one looping clip. */
export function chainToClips(chain: number[], tracks: number, steps: number): Clip[] {
  const clips: Clip[] = [];
  for (let i = 0; i < chain.length;) {
    let j = i + 1;
    while (j < chain.length && chain[j] === chain[i]) j++;
    for (let t = 0; t < tracks; t++) clips.push({ id: newId(), track: t, pattern: chain[i], start: i * steps, len: (j - i) * steps, offset: 0 });
    i = j;
  }
  return clips;
}

export function emptyArrangement(tracks: number, steps: number): Arrangement {
  return { clips: chainToClips([0], tracks, steps), lanes: [], tempo: [], sigs: [], markers: [], loopOn: false, loopStart: 0, loopEnd: 0 };
}

export function emptyProject(): Project {
  const tracks = defaultTracks();
  return {
    v: 2, name: 'untitled', bpm: 120, swing: 0, groove: 0, grooveAmt: 50, steps: 16,
    tracks, buses: [],
    patterns: Array.from({ length: NUM_PATTERNS }, () => newPattern(tracks.length)),
    arr: emptyArrangement(tracks.length, 16), songMode: false,
    scaleRoot: 0, scaleType: 1, scaleLock: true,
    fx: defaultFx(), master: 100, lyrics: [], mastering: defaultMastering(),
  };
}

function sanitizeRack(list: unknown): InsertFx[] {
  const fx: InsertFx[] = [];
  for (const x of Array.isArray(list) ? list.slice(0, MAX_INSERTS) : []) {
    if (!INSERT_TYPES.includes(x?.type)) continue;
    const knobs = INSERTS[x.type as InsertType].knobs;
    fx.push({ type: x.type, on: x.on !== false, p: knobs.map((k, j) => int(x.p?.[j], 0, 127, k.def)) });
  }
  return fx;
}

export const newBus = (n: number): Bus => ({ name: `GROUP ${n}`, vol: 100, mute: false, fx: [] });

/** Coerce anything (a parsed project file, a decoded link) into a valid Project. */
export function sanitize(raw: any): Project {
  const base = emptyProject();
  if (!raw || typeof raw !== 'object') return base;
  const buses: Bus[] = (Array.isArray(raw.buses) ? raw.buses.slice(0, MAX_BUSES) : []).map((b: any, i: number) => ({
    name: typeof b?.name === 'string' && b.name ? b.name.slice(0, 12) : `GROUP ${i + 1}`,
    vol: int(b?.vol, 0, 127, 100), mute: !!b?.mute, fx: sanitizeRack(b?.fx),
  }));
  const rt: any[] = Array.isArray(raw.tracks) ? raw.tracks.slice(0, MAX_TRACKS) : [];
  const tracks: Track[] = rt.map((t, i) => {
    const d = newTrack(TRACK_KINDS.includes(t?.kind) ? t.kind : 'drum', i, `TRACK ${i + 1}`);
    const b = t?.bass ?? {}, db = d.bass;
    const ds2 = t?.dsyn ?? {};
    const model = int(ds2.model, 0, DRUM_MODELS.length - 1, 0);
    const dd = DRUM_DEFAULTS[model];
    const s = t?.synth ?? {};
    const ds = d.synth;
    const wave = int(s.wave, 0, NUM_WAVES - 1, ds.wave);
    const dx = synthExtras(wave); // what a synth saved before these settings existed should get
    const slices: number[] = [];
    for (const x of Array.isArray(t?.slices) ? t.slices.slice(0, MAX_SLICES) : []) {
      const v = int(x, 0, 65535, -1);
      if (v >= 0 && !slices.includes(v)) slices.push(v);
    }
    slices.sort((a, b) => a - b);
    const fx = sanitizeRack(t?.fx);
    return {
      name: typeof t?.name === 'string' ? t.name.slice(0, 16) : d.name,
      kind: d.kind,
      color: int(t?.color, 0, 7, i),
      sample: typeof t?.sample === 'string' ? t.sample.slice(0, 80) : d.sample,
      tune: int(t?.tune, -24, 24, 0),
      decay: int(t?.decay, 0, 127, 127),
      reverse: !!t?.reverse,
      stretch: int(t?.stretch, 0, 127, 64),
      slices, fx,
      synth: {
        wave, pos: int(s.pos, 0, 127, 0),
        wave2: int(s.wave2, 0, NUM_WAVES - 1, 0), pos2: int(s.pos2, 0, 127, 0),
        semi2: int(s.semi2, -24, 24, 0), fine2: int(s.fine2, -50, 50, 0),
        mix: int(s.mix, 0, 127, 0), noise: int(s.noise, 0, 127, 0),
        uni: int(s.uni, 1, MAX_UNISON, dx.uni), detune: int(s.detune, 0, 127, dx.detune), spread: int(s.spread, 0, 127, 0),
        lfoShape: int(s.lfoShape, 0, LFO_SHAPES.length - 1, 0), lfoRate: int(s.lfoRate, 0, 127, 64), lfoSync: !!s.lfoSync,
        lfoAmt: int(s.lfoAmt, -64, 63, 0), lfoDest: int(s.lfoDest, 0, MOD_DESTS.length - 1, 0),
        menvAttack: int(s.menvAttack, 0, 127, 0), menvDecay: int(s.menvDecay, 0, 127, 50),
        menvAmt: int(s.menvAmt, -64, 63, 0), menvDest: int(s.menvDest, 0, MOD_DESTS.length - 1, 0),
        cutoff: int(s.cutoff, 0, 127, ds.cutoff),
        reso: int(s.reso, 0, 127, ds.reso), env: int(s.env, 0, 127, ds.env),
        attack: int(s.attack, 0, 127, ds.attack), decay: int(s.decay, 0, 127, ds.decay),
        sustain: int(s.sustain, 0, 127, ds.sustain), release: int(s.release, 0, 127, ds.release),
      },
      bass: {
        glide: int(b.glide, 0, 127, db.glide), drive: int(b.drive, 0, 127, db.drive), decay: int(b.decay, 0, 127, db.decay),
        tone: int(b.tone, 0, 127, db.tone), punch: int(b.punch, 0, 127, db.punch), follow: b.follow !== false, key: int(b.key, 0, 11, 0),
      },
      dsyn: {
        model, tune: int(ds2.tune, -24, 24, dd.tune), decay: int(ds2.decay, 0, 127, dd.decay),
        tone: int(ds2.tone, 0, 127, dd.tone), snap: int(ds2.snap, 0, 127, dd.snap),
      },
      note: int(t?.note, 0, 127, d.note),
      vol: int(t?.vol, 0, 127, 100),
      pan: int(t?.pan, -64, 63, 0),
      mute: !!t?.mute, solo: !!t?.solo,
      filter: int(t?.filter, -64, 63, 0),
      rev: int(t?.rev, 0, 127, 0), dly: int(t?.dly, 0, 127, 0),
      groove: int(t?.groove, 0, GROOVES.length - 1, 0), grooveAmt: int(t?.grooveAmt, 0, 100, 50),
      arpMode: int(t?.arpMode, 0, ARP_MODES.length - 1, 0), arpRate: int(t?.arpRate, 0, ARP_RATES.length - 1, 2),
      arpOct: int(t?.arpOct, 1, MAX_ARP_OCT, 1), arpGate: int(t?.arpGate, 1, 127, 100),
      bus: int(t?.bus, 0, buses.length, 0),
    };
  });
  if (!tracks.length) tracks.push(...base.tracks);
  const n = tracks.length;
  const patterns: Pattern[] = [];
  for (let p = 0; p < NUM_PATTERNS; p++) {
    const rp = raw.patterns?.[p];
    const pat = newPattern(n);
    for (let t = 0; t < n; t++) {
      const rs = rp?.steps?.[t];
      if (Array.isArray(rs)) for (let s = 0; s < MAX_STEPS; s++) pat.steps[t][s] = int(rs[s], 0, 127, 0);
      const rm = rp?.mods?.[t];
      if (Array.isArray(rm)) for (let s = 0; s < MAX_STEPS; s++) pat.mods[t][s] = int(rm[s], 0, MAX_MOD, 0);
      const rn = rp?.notes?.[t];
      if (Array.isArray(rn)) {
        for (const x of rn.slice(0, 512)) {
          const s = int(x?.s, 0, MAX_STEPS - 1, -1);
          if (s < 0) continue;
          pat.notes[t].push({ s, l: int(x?.l, 1, MAX_STEPS, 1), p: int(x?.p, 0, 127, 60), v: int(x?.v, 1, 127, DEFAULT_VEL) });
        }
      }
    }
    patterns.push(pat);
  }
  const f = raw.fx ?? {};
  const df = base.fx;
  const steps = raw.steps === 32 ? 32 : 16;
  return {
    v: 2,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : base.name,
    bpm: int(raw.bpm, 40, 240, 120),
    swing: int(raw.swing, 0, 100, 0),
    groove: int(raw.groove, 0, GROOVES.length - 1, 0),
    grooveAmt: int(raw.grooveAmt, 0, 100, 50),
    steps,
    tracks, buses, patterns,
    arr: sanitizeArrangement(raw, n, steps),
    songMode: !!raw.songMode,
    scaleRoot: int(raw.scaleRoot, 0, 11, 0),
    scaleType: int(raw.scaleType, 0, 15, 1),
    scaleLock: raw.scaleLock !== false,
    fx: {
      revSize: int(f.revSize, 0, 127, df.revSize), revDamp: int(f.revDamp, 0, 127, df.revDamp),
      revLevel: int(f.revLevel, 0, 127, df.revLevel),
      dlyTime: int(f.dlyTime, 0, DELAY_DIVS.length - 1, df.dlyTime),
      dlyFb: int(f.dlyFb, 0, 127, df.dlyFb), dlyLevel: int(f.dlyLevel, 0, 127, df.dlyLevel),
      filter: int(f.filter, -64, 63, 0), filterRes: int(f.filterRes, 0, 127, df.filterRes),
      compOn: f.compOn !== false,
      compThresh: int(f.compThresh, 0, 127, df.compThresh), compRatio: int(f.compRatio, 0, 127, df.compRatio),
      compMakeup: int(f.compMakeup, 0, 127, df.compMakeup),
      revMute: !!f.revMute, dlyMute: !!f.dlyMute,
    },
    master: int(raw.master, 0, 127, 100),
    lyrics: (Array.isArray(raw.lyrics) ? raw.lyrics.slice(0, MAX_LYRICS) : [])
      .map((l: any) => ({ at: int(l?.at, 0, MAX_SONG_STEPS - 1, 0), text: str(l?.text, 120, '') }))
      .sort((a: LyricLine, b: LyricLine) => a.at - b.at),
    mastering: {
      on: !!raw.mastering?.on,
      low: int(raw.mastering?.low, 0, 127, 64), mid: int(raw.mastering?.mid, 0, 127, 64), high: int(raw.mastering?.high, 0, 127, 64),
      glue: int(raw.mastering?.glue, 0, 127, 40), width: int(raw.mastering?.width, 0, 127, 64), gain: int(raw.mastering?.gain, 0, 127, 64),
      target: int(raw.mastering?.target, 0, 30, 14),
    },
  };
}

const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.slice(0, max) : d);

/** Drop or trim clips so that no two on the same track overlap; later clips win. */
export function resolveOverlaps(clips: Clip[], steps: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const end = c.start + c.len;
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (o.track !== c.track || o.start >= end || o.start + o.len <= c.start) continue;
      const oEnd = o.start + o.len;
      if (o.start < c.start && oEnd > end) {
        // the new clip lands in the middle: keep both sides
        out.push({ ...o, id: newId(), start: end, len: oEnd - end, offset: (o.offset + end - o.start) % steps });
        o.len = c.start - o.start;
      } else if (o.start < c.start) o.len = c.start - o.start;
      else if (oEnd > end) { o.offset = (o.offset + end - o.start) % steps; o.len = oEnd - end; o.start = end; }
      else out.splice(i, 1);
    }
    out.push(c);
  }
  return out;
}

function sanitizeArrangement(raw: any, tracks: number, steps: number): Arrangement {
  const a = raw.arr;
  if (!a || typeof a !== 'object') {
    // version 1 projects had a chain of patterns instead of a timeline
    const chain = (Array.isArray(raw.song) ? raw.song : [0]).slice(0, 64).map((x: unknown) => int(x, 0, NUM_PATTERNS - 1, 0));
    return emptyArrangementFrom(chain.length ? chain : [0], tracks, steps);
  }
  const ids = new Set<string>();
  const id = (v: unknown) => {
    let s = typeof v === 'string' && v && v.length <= 16 && !ids.has(v) ? v : newId();
    while (ids.has(s)) s = newId();
    ids.add(s);
    return s;
  };
  const clips: Clip[] = [];
  for (const c of Array.isArray(a.clips) ? a.clips.slice(0, MAX_CLIPS) : []) {
    const track = int(c?.track, 0, MAX_TRACKS - 1, -1);
    const start = int(c?.start, 0, MAX_SONG_STEPS - 1, -1);
    if (track < 0 || track >= tracks || start < 0) continue;
    clips.push({
      id: id(c?.id), track, start,
      pattern: int(c?.pattern, 0, NUM_PATTERNS - 1, 0),
      len: int(c?.len, 1, MAX_SONG_STEPS - start, steps),
      offset: int(c?.offset, 0, MAX_STEPS - 1, 0) % steps,
    });
  }
  const lanes: AutoLane[] = [];
  for (const l of Array.isArray(a.lanes) ? a.lanes.slice(0, MAX_LANES) : []) {
    const def = PARAMS.find((d) => d.id === l?.param);
    const track = int(l?.track, -1, MAX_TRACKS - 1, -2);
    if (!def || track < -1 || track >= tracks || (def.scope === 'master') !== (track === -1)) continue;
    if (lanes.some((x) => x.track === track && x.param === def.id)) continue;
    const points: AutoPoint[] = [];
    for (const pt of Array.isArray(l.points) ? l.points.slice(0, MAX_POINTS) : []) {
      const t = int(pt?.t, 0, MAX_SONG_STEPS, -1);
      if (t >= 0) points.push({ t, v: int(pt?.v, def.min, def.max, def.def) });
    }
    points.sort((x, y) => x.t - y.t);
    lanes.push({ id: id(l.id), track, param: def.id, on: l.on !== false, points: points.filter((pt, i) => !i || pt.t !== points[i - 1].t) });
  }
  const events = <T extends { at: number }>(list: unknown, make: (e: any, at: number) => T | null): T[] => {
    const out: T[] = [];
    for (const e of Array.isArray(list) ? list.slice(0, MAX_EVENTS) : []) {
      const at = int(e?.at, 0, MAX_SONG_STEPS - 1, -1);
      const made = at >= 0 ? make(e, at) : null;
      if (made && !out.some((o) => o.at === at)) out.push(made);
    }
    return out.sort((x, y) => x.at - y.at);
  };
  const loopStart = int(a.loopStart, 0, MAX_SONG_STEPS, 0);
  const loopEnd = int(a.loopEnd, 0, MAX_SONG_STEPS, 0);
  return {
    clips: resolveOverlaps(clips, steps),
    lanes,
    tempo: events<TempoEvent>(a.tempo, (e, at) => (at > 0 ? { at, bpm: int(e.bpm, 40, 240, 120) } : null)),
    sigs: events<SigEvent>(a.sigs, (e, at) => ({ at, num: int(e.num, 1, 16, 4), den: [2, 4, 8, 16].includes(e.den) ? e.den : 4 })),
    markers: events<Marker>(a.markers, (e, at) => ({ at, name: str(e.name, 24, 'marker'), color: int(e.color, 0, 7, 0) })),
    loopOn: !!a.loopOn && loopEnd > loopStart,
    loopStart, loopEnd: Math.max(loopStart, loopEnd),
  };
}

function emptyArrangementFrom(chain: number[], tracks: number, steps: number): Arrangement {
  return { ...emptyArrangement(tracks, steps), clips: chainToClips(chain, tracks, steps) };
}
