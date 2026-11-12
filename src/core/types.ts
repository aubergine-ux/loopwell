// The project model. Every knob value is a small integer (mostly 0..127, like
// MIDI CCs) so beats round-trip exactly through the share-link codec.

export const MAX_TRACKS = 8;
export const NUM_PATTERNS = 4;
export const MAX_STEPS = 32;
export const DEFAULT_VEL = 100;

export type TrackKind = 'drum' | 'synth';

export interface SynthParams {
  wave: number; // 0 saw, 1 square, 2 triangle, 3 sine
  cutoff: number;
  reso: number;
  env: number; // filter envelope amount
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface Track {
  name: string;
  kind: TrackKind;
  color: number; // 0..7, index into the theme's track palette
  sample: string; // "kit/slot" for built-ins, "user/<id>" for dropped files
  tune: number; // semitones, -24..24
  decay: number; // 127 = play the whole sample
  synth: SynthParams;
  note: number; // MIDI pitch used when a synth track is toggled from the step grid / pads
  vol: number; // 100 = unity
  pan: number; // -64..63
  mute: boolean;
  solo: boolean;
  filter: number; // -64..63, negative = low-pass, positive = high-pass
  rev: number;
  dly: number;
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
}

export interface Project {
  v: 1;
  name: string;
  bpm: number; // 40..240
  swing: number; // 0..100
  steps: 16 | 32;
  tracks: Track[];
  patterns: Pattern[];
  song: number[]; // pattern indices
  songMode: boolean;
  scaleRoot: number; // 0..11
  scaleType: number; // index into SCALES
  scaleLock: boolean;
  fx: Fx;
  master: number; // 100 = unity
}

/** Delay times in 16th-note steps. */
export const DELAY_DIVS = [1, 4 / 3, 2, 3, 4, 6];
export const DELAY_LABELS = ['1/16', '1/8T', '1/8', '1/8D', '1/4', '1/4D'];
export const WAVES = ['SAW', 'SQR', 'TRI', 'SIN'];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const int = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : d;

export function defaultSynth(): SynthParams {
  return { wave: 0, cutoff: 70, reso: 30, env: 60, attack: 0, decay: 50, sustain: 40, release: 30 };
}

export function newTrack(kind: TrackKind, color: number, name: string, sample = 'boom/kick'): Track {
  return {
    name, kind, color, sample,
    tune: 0, decay: 127,
    synth: defaultSynth(), note: 48,
    vol: 100, pan: 0, mute: false, solo: false,
    filter: 0, rev: 0, dly: 0,
  };
}

export function newPattern(tracks: number): Pattern {
  return {
    steps: Array.from({ length: tracks }, () => new Array<number>(MAX_STEPS).fill(0)),
    notes: Array.from({ length: tracks }, () => [] as Note[]),
  };
}

export function defaultFx(): Fx {
  return {
    revSize: 70, revDamp: 60, revLevel: 90,
    dlyTime: 3, dlyFb: 50, dlyLevel: 90,
    filter: 0, filterRes: 30,
    compOn: true, compThresh: 40, compRatio: 40, compMakeup: 20,
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
  t[6].synth = { wave: 0, cutoff: 46, reso: 40, env: 70, attack: 0, decay: 46, sustain: 30, release: 20 };
  t[7].note = 60;
  t[7].synth = { wave: 1, cutoff: 78, reso: 24, env: 40, attack: 2, decay: 60, sustain: 50, release: 50 };
  t[7].vol = 80;
  t[7].dly = 50;
  t[7].rev = 40;
  return t;
}

export function emptyProject(): Project {
  const tracks = defaultTracks();
  return {
    v: 1, name: 'untitled', bpm: 120, swing: 0, steps: 16,
    tracks,
    patterns: Array.from({ length: NUM_PATTERNS }, () => newPattern(tracks.length)),
    song: [0], songMode: false,
    scaleRoot: 0, scaleType: 1, scaleLock: true,
    fx: defaultFx(), master: 100,
  };
}

/** Coerce anything (a parsed project file, a decoded link) into a valid Project. */
export function sanitize(raw: any): Project {
  const base = emptyProject();
  if (!raw || typeof raw !== 'object') return base;
  const rt: any[] = Array.isArray(raw.tracks) ? raw.tracks.slice(0, MAX_TRACKS) : [];
  const tracks: Track[] = rt.map((t, i) => {
    const d = newTrack(t?.kind === 'synth' ? 'synth' : 'drum', i, `TRACK ${i + 1}`);
    const s = t?.synth ?? {};
    const ds = d.synth;
    return {
      name: typeof t?.name === 'string' ? t.name.slice(0, 16) : d.name,
      kind: d.kind,
      color: int(t?.color, 0, 7, i),
      sample: typeof t?.sample === 'string' ? t.sample.slice(0, 80) : d.sample,
      tune: int(t?.tune, -24, 24, 0),
      decay: int(t?.decay, 0, 127, 127),
      synth: {
        wave: int(s.wave, 0, 3, ds.wave), cutoff: int(s.cutoff, 0, 127, ds.cutoff),
        reso: int(s.reso, 0, 127, ds.reso), env: int(s.env, 0, 127, ds.env),
        attack: int(s.attack, 0, 127, ds.attack), decay: int(s.decay, 0, 127, ds.decay),
        sustain: int(s.sustain, 0, 127, ds.sustain), release: int(s.release, 0, 127, ds.release),
      },
      note: int(t?.note, 0, 127, 48),
      vol: int(t?.vol, 0, 127, 100),
      pan: int(t?.pan, -64, 63, 0),
      mute: !!t?.mute, solo: !!t?.solo,
      filter: int(t?.filter, -64, 63, 0),
      rev: int(t?.rev, 0, 127, 0), dly: int(t?.dly, 0, 127, 0),
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
  const song = (Array.isArray(raw.song) ? raw.song : [0]).slice(0, 64).map((x: unknown) => int(x, 0, NUM_PATTERNS - 1, 0));
  return {
    v: 1,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : base.name,
    bpm: int(raw.bpm, 40, 240, 120),
    swing: int(raw.swing, 0, 100, 0),
    steps: raw.steps === 32 ? 32 : 16,
    tracks, patterns,
    song: song.length ? song : [0],
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
    },
    master: int(raw.master, 0, 127, 100),
  };
}
