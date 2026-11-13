// Share links. The whole beat is packed into a compact binary layout,
// deflated, and base64url-encoded into the URL fragment. Nothing is uploaded
// anywhere. Built-in samples are stored as a one-byte reference; samples you
// dropped in yourself cannot travel in a link (use a project file for those).
//
// Format history. The first byte is the version; every version ever released
// still loads.
//   1  beats: tracks, four patterns and a chain of patterns
//   2  songs: a list of tagged chunks (settings, tracks, patterns, timeline).
//      Readers skip chunks and trailing bytes they don't know, so later
//      additions don't need a new version. Added since: Sound (2.0), Creative (2.1).

import { deflateSync, inflateSync } from 'fflate';
import { KITS, SLOTS, isBuiltin } from './kits';
import { isDefaultArrangement } from './arrange';
import { PARAMS } from './params';
import { INSERT_TYPES } from './dsp/inserts';
import { DEFAULT_VEL, MAX_STEPS, NUM_PATTERNS, newTrack, sanitize, synthExtras, usesNotes, type Clip, type Project, type Track } from './types';

const VERSION = 2;
const V1_PATTERNS = 4;
const enum Chunk { Settings = 1, Tracks = 2, Patterns = 3, Timeline = 4, Sound = 5, Creative = 6 }
const ALL_TRACKS = 255;
export const HASH_KEY = 'b';

class Writer {
  private buf = new Uint8Array(256);
  private n = 0;
  u8(v: number): void {
    if (this.n === this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = v & 255;
  }
  u32(v: number): void {
    this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24);
  }
  /** Unsigned LEB128: small numbers take one byte. */
  vu(v: number): void {
    while (v > 127) { this.u8((v & 127) | 128); v = Math.floor(v / 128); }
    this.u8(v);
  }
  chunk(tag: number, body: Writer): void {
    const b = body.bytes();
    this.u8(tag);
    this.vu(b.length);
    for (const c of b) this.u8(c);
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s).subarray(0, 255);
    this.u8(b.length);
    for (const c of b) this.u8(c);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

class Reader {
  private n = 0;
  constructor(private buf: Uint8Array) {}
  u8(): number {
    if (this.n >= this.buf.length) throw new Error('truncated');
    return this.buf[this.n++];
  }
  u32(): number {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }
  vu(): number {
    let v = 0, mul = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
    throw new Error('bad number');
  }
  get more(): boolean {
    return this.n < this.buf.length;
  }
  /** A reader over the next `len` bytes, which are skipped here. */
  sub(len: number): Reader {
    if (this.n + len > this.buf.length) throw new Error('truncated');
    const r = new Reader(this.buf.subarray(this.n, this.n + len));
    this.n += len;
    return r;
  }
  str(): string {
    const len = this.u8();
    if (this.n + len > this.buf.length) throw new Error('truncated');
    const s = new TextDecoder().decode(this.buf.subarray(this.n, this.n + len));
    this.n += len;
    return s;
  }
}

function writeSettings(w: Writer, p: Project): void {
  w.u8(p.bpm - 40);
  w.u8(p.swing);
  w.u8((p.steps === 32 ? 1 : 0) | (p.songMode ? 2 : 0) | (p.scaleLock ? 4 : 0) | (p.fx.compOn ? 8 : 0));
  w.u8((p.scaleRoot << 4) | p.scaleType);
  w.u8(p.master);
  const f = p.fx;
  for (const v of [f.revSize, f.revDamp, f.revLevel, f.dlyTime, f.dlyFb, f.dlyLevel, f.filter + 64, f.filterRes, f.compThresh, f.compRatio, f.compMakeup]) w.u8(v);
}

function readSettings(r: Reader, raw: any): void {
  raw.bpm = r.u8() + 40;
  raw.swing = r.u8();
  const flags = r.u8();
  raw.steps = flags & 1 ? 32 : 16;
  raw.songMode = !!(flags & 2);
  raw.scaleLock = !!(flags & 4);
  const sc = r.u8();
  raw.scaleRoot = sc >> 4;
  raw.scaleType = sc & 15;
  raw.master = r.u8();
  raw.fx = {
    revSize: r.u8(), revDamp: r.u8(), revLevel: r.u8(), dlyTime: r.u8(), dlyFb: r.u8(), dlyLevel: r.u8(),
    filter: r.u8() - 64, filterRes: r.u8(), compThresh: r.u8(), compRatio: r.u8(), compMakeup: r.u8(),
    compOn: !!(flags & 8),
  };
}

function writeTracks(w: Writer, p: Project): void {
  w.u8(p.tracks.length);
  for (const t of p.tracks) {
    const builtin = isBuiltin(t.sample);
    const synth = t.kind === 'synth';
    w.u8((synth ? 1 : 0) | (t.mute ? 2 : 0) | (t.solo ? 4 : 0) | ((t.color & 7) << 3) | (!synth && !builtin ? 64 : 0) | (t.kind === 'slice' ? 128 : 0));
    w.str(t.name);
    if (synth) {
      const s = t.synth;
      for (const v of [s.wave, s.cutoff, s.reso, s.env, s.attack, s.decay, s.sustain, s.release, t.note]) w.u8(v);
    } else {
      if (t.kind === 'slice') w.u8(t.note);
      if (builtin) {
        const [kit, slot] = t.sample.split('/');
        w.u8((KITS.findIndex((k) => k.id === kit) << 4) | (SLOTS as readonly string[]).indexOf(slot));
      } else {
        w.str(t.sample);
      }
      w.u8(t.tune + 24);
      w.u8(t.decay);
    }
    for (const v of [t.vol, t.pan + 64, t.filter + 64, t.rev, t.dly]) w.u8(v);
  }
}

function readTracks(r: Reader, raw: any): void {
  const nt = r.u8();
  if (nt < 1 || nt > 8) throw new Error('bad track count');
  raw.tracks = [];
  for (let i = 0; i < nt; i++) {
    const tf = r.u8();
    const t: any = { kind: tf & 1 ? 'synth' : tf & 128 ? 'slice' : 'drum', mute: !!(tf & 2), solo: !!(tf & 4), color: (tf >> 3) & 7 };
    t.name = r.str();
    if (tf & 1) {
      t.synth = { wave: r.u8(), cutoff: r.u8(), reso: r.u8(), env: r.u8(), attack: r.u8(), decay: r.u8(), sustain: r.u8(), release: r.u8() };
      t.note = r.u8();
    } else {
      if (tf & 128) t.note = r.u8();
      if (tf & 64) t.sample = r.str();
      else {
        const b = r.u8();
        const kit = KITS[b >> 4], slot = SLOTS[b & 15];
        if (!kit || !slot) throw new Error('bad sample');
        t.sample = `${kit.id}/${slot}`;
      }
      t.tune = r.u8() - 24;
      t.decay = r.u8();
    }
    t.vol = r.u8(); t.pan = r.u8() - 64; t.filter = r.u8() - 64; t.rev = r.u8(); t.dly = r.u8();
    raw.tracks.push(t);
  }
}

function writePatterns(w: Writer, p: Project): void {
  const used = p.patterns.map((pat, i) =>
    p.tracks.some((t, ti) => (usesNotes(t.kind) ? pat.notes[ti].length > 0 : pat.steps[ti].some((v) => v > 0))) ? 1 << i : 0);
  w.u8(used.reduce((a, b) => a | b, 0));
  p.patterns.forEach((pat, i) => {
    if (!used[i]) return;
    p.tracks.forEach((t, ti) => {
      if (usesNotes(t.kind)) {
        const notes = pat.notes[ti].slice(0, 255);
        w.u8(notes.length);
        for (const n of notes) { w.u8(n.s); w.u8(n.l); w.u8(n.p); w.u8(n.v); }
      } else {
        const steps = pat.steps[ti];
        let mask = 0;
        for (let s = 0; s < MAX_STEPS; s++) if (steps[s]) mask |= 1 << s;
        w.u32(mask >>> 0);
        if (!mask) return;
        // most beats leave velocity alone, so that case costs a single byte
        const plain = steps.every((v) => v === 0 || v === DEFAULT_VEL);
        w.u8(plain ? 0 : 1);
        if (!plain) for (const v of steps) if (v) w.u8(v);
      }
    });
  });
}

function readPatterns(r: Reader, raw: any, count: number): void {
  const nt = raw.tracks.length;
  const used = r.u8();
  raw.patterns = [];
  for (let i = 0; i < count; i++) {
    const pat: any = { steps: [], notes: [] };
    for (let ti = 0; ti < nt; ti++) {
      const steps = new Array(MAX_STEPS).fill(0);
      const notes: any[] = [];
      if (used & (1 << i)) {
        if (raw.tracks[ti].kind !== 'drum') {
          const n = r.u8();
          for (let k = 0; k < n; k++) notes.push({ s: r.u8(), l: r.u8(), p: r.u8(), v: r.u8() });
        } else {
          const mask = r.u32();
          if (mask) {
            const plain = r.u8() === 0;
            for (let s = 0; s < MAX_STEPS; s++) if (mask & (1 << s)) steps[s] = plain ? DEFAULT_VEL : r.u8();
          }
        }
      }
      pat.steps.push(steps);
      pat.notes.push(notes);
    }
    raw.patterns.push(pat);
  }
}

// The Sound chunk holds everything added to tracks after the first release:
// the bigger synth, sampler settings and effect racks. One record per track,
// starting with a byte saying which parts follow, so a plain track costs one byte.
const enum Part { Synth = 1, Sampler = 2, Rack = 4 }

function soundParts(t: Track): number {
  const s = t.synth;
  const plain = synthExtras(s.wave) as Record<string, number | boolean>;
  const synth = t.kind === 'synth' && Object.keys(plain).some((k) => (s as unknown as Record<string, number | boolean>)[k] !== plain[k]);
  const sampler = t.kind !== 'synth' && (t.reverse || t.stretch !== 64 || t.slices.length > 0);
  return (synth ? Part.Synth : 0) | (sampler ? Part.Sampler : 0) | (t.fx.length ? Part.Rack : 0);
}

function writeSound(w: Writer, p: Project): void {
  for (const t of p.tracks) {
    const parts = soundParts(t);
    w.u8(parts);
    if (parts & Part.Synth) {
      const s = t.synth;
      for (const v of [s.pos, s.wave2, s.pos2, s.semi2 + 24, s.fine2 + 50, s.mix, s.noise, s.uni, s.detune, s.spread,
        s.lfoShape | (s.lfoSync ? 128 : 0), s.lfoRate, s.lfoAmt + 64, s.lfoDest, s.menvAttack, s.menvDecay, s.menvAmt + 64, s.menvDest]) w.u8(v);
    }
    if (parts & Part.Sampler) {
      w.u8(t.reverse ? 1 : 0);
      w.u8(t.stretch);
      w.u8(t.slices.length);
      for (const x of t.slices) { w.u8(x); w.u8(x >> 8); }
    }
    if (parts & Part.Rack) {
      w.u8(t.fx.length);
      for (const fx of t.fx) {
        w.u8(INSERT_TYPES.indexOf(fx.type) | (fx.on ? 128 : 0));
        for (let k = 0; k < 4; k++) w.u8(fx.p[k]);
      }
    }
  }
}

function readSound(r: Reader, raw: any): void {
  for (const t of raw.tracks) {
    if (!r.more) return;
    const parts = r.u8();
    if (parts & Part.Synth) {
      const s = (t.synth ??= {});
      s.pos = r.u8(); s.wave2 = r.u8(); s.pos2 = r.u8(); s.semi2 = r.u8() - 24; s.fine2 = r.u8() - 50;
      s.mix = r.u8(); s.noise = r.u8(); s.uni = r.u8(); s.detune = r.u8(); s.spread = r.u8();
      const shape = r.u8();
      s.lfoShape = shape & 127; s.lfoSync = !!(shape & 128);
      s.lfoRate = r.u8(); s.lfoAmt = r.u8() - 64; s.lfoDest = r.u8();
      s.menvAttack = r.u8(); s.menvDecay = r.u8(); s.menvAmt = r.u8() - 64; s.menvDest = r.u8();
    }
    if (parts & Part.Sampler) {
      t.reverse = !!(r.u8() & 1);
      t.stretch = r.u8();
      t.slices = [];
      for (let n = r.u8(); n > 0; n--) t.slices.push(r.u8() | (r.u8() << 8));
    }
    if (parts & Part.Rack) {
      t.fx = [];
      for (let n = r.u8(); n > 0; n--) {
        const b = r.u8();
        const fx = { type: INSERT_TYPES[b & 127], on: !!(b & 128), p: [r.u8(), r.u8(), r.u8(), r.u8()] };
        if (fx.type) t.fx.push(fx); // an effect this version doesn't know is left out
      }
    }
  }
}

function writeTimeline(w: Writer, p: Project): void {
  const a = p.arr;
  w.u8(a.loopOn ? 1 : 0);
  w.vu(a.loopStart);
  w.vu(a.loopEnd);

  // a clip that sits on every track at once (a whole section) is written once
  const key = (c: Clip) => `${c.pattern},${c.start},${c.len},${c.offset}`;
  const groups = new Map<string, Clip[]>();
  for (const c of a.clips) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  const out: [number, Clip][] = [];
  for (const g of groups.values()) {
    if (g.length === p.tracks.length && p.tracks.length > 1) out.push([ALL_TRACKS, g[0]]);
    else for (const c of g) out.push([c.track, c]);
  }
  w.vu(out.length);
  for (const [track, c] of out) { w.u8(track); w.u8(c.pattern); w.vu(c.start); w.vu(c.len); w.u8(c.offset); }

  w.u8(a.lanes.length);
  for (const l of a.lanes) {
    const pi = PARAMS.findIndex((d) => d.id === l.param);
    w.u8(l.track + 1); w.u8(pi); w.u8(l.on ? 1 : 0);
    w.vu(l.points.length);
    let last = 0;
    for (const pt of l.points) { w.vu(pt.t - last); w.u8(pt.v - PARAMS[pi].min); last = pt.t; }
  }
  let last = 0;
  w.u8(a.tempo.length);
  for (const e of a.tempo) { w.vu(e.at - last); w.u8(e.bpm - 40); last = e.at; }
  last = 0;
  w.u8(a.sigs.length);
  for (const e of a.sigs) { w.vu(e.at - last); w.u8(e.num); w.u8(Math.round(Math.log2(e.den))); last = e.at; }
  last = 0;
  w.u8(a.markers.length);
  for (const m of a.markers) { w.vu(m.at - last); w.u8(m.color); w.str(m.name); last = m.at; }
}

function readTimeline(r: Reader, raw: any): void {
  const nt = raw.tracks.length;
  const a: any = { loopOn: !!(r.u8() & 1), loopStart: r.vu(), loopEnd: r.vu(), clips: [], lanes: [], tempo: [], sigs: [], markers: [] };
  for (let n = r.vu(); n > 0; n--) {
    const track = r.u8();
    const c = { pattern: r.u8(), start: r.vu(), len: r.vu(), offset: r.u8() };
    if (track === ALL_TRACKS) for (let t = 0; t < nt; t++) a.clips.push({ ...c, track: t });
    else a.clips.push({ ...c, track });
  }
  for (let n = r.u8(); n > 0; n--) {
    const track = r.u8() - 1;
    const def = PARAMS[r.u8()];
    const on = !!(r.u8() & 1);
    const points: any[] = [];
    let t = 0;
    for (let k = r.vu(); k > 0; k--) { t += r.vu(); points.push({ t, v: r.u8() + (def?.min ?? 0) }); }
    if (def) a.lanes.push({ track, param: def.id, on, points }); // a knob this version doesn't know is dropped
  }
  let at = 0;
  for (let n = r.u8(); n > 0; n--) { at += r.vu(); a.tempo.push({ at, bpm: r.u8() + 40 }); }
  at = 0;
  for (let n = r.u8(); n > 0; n--) { at += r.vu(); a.sigs.push({ at, num: r.u8(), den: 1 << r.u8() }); }
  at = 0;
  for (let n = r.u8(); n > 0; n--) { at += r.vu(); a.markers.push({ at, color: r.u8(), name: r.str() }); }
  raw.arr = a;
}

// The Creative chunk: grooves, arpeggiators and the per-step extras (chance,
// conditions, ratchets). Left out entirely when a beat uses none of them.
const enum Extra { Groove = 1, Arp = 2 }
const DEFAULT_TRACK = newTrack('drum', 0, '');

const trackExtras = (t: Track) =>
  (t.groove !== DEFAULT_TRACK.groove || t.grooveAmt !== DEFAULT_TRACK.grooveAmt ? Extra.Groove : 0)
  | (t.arpMode !== DEFAULT_TRACK.arpMode || t.arpRate !== DEFAULT_TRACK.arpRate || t.arpOct !== DEFAULT_TRACK.arpOct || t.arpGate !== DEFAULT_TRACK.arpGate ? Extra.Arp : 0);

function hasCreative(p: Project): boolean {
  return p.groove !== 0 || p.grooveAmt !== 50 || p.tracks.some((t) => trackExtras(t)) || p.patterns.some((pat) => pat.mods.some((row) => row.some((m) => m)));
}

function writeCreative(w: Writer, p: Project): void {
  w.u8(p.groove);
  w.u8(p.grooveAmt);
  for (const t of p.tracks) {
    const parts = trackExtras(t);
    w.u8(parts);
    if (parts & Extra.Groove) { w.u8(t.groove); w.u8(t.grooveAmt); }
    if (parts & Extra.Arp) { w.u8(t.arpMode | (t.arpRate << 3) | ((t.arpOct - 1) << 5)); w.u8(t.arpGate); }
  }
  const used = p.patterns.map((pat) => pat.mods.some((row) => row.some((m) => m)));
  w.u8(used.reduce((a, on, i) => a | (on ? 1 << i : 0), 0));
  p.patterns.forEach((pat, i) => {
    if (!used[i]) return;
    for (const row of pat.mods.slice(0, p.tracks.length)) {
      w.u8(row.filter((m) => m).length);
      row.forEach((m, s) => { if (m) { w.u8(s); w.vu(m); } });
    }
  });
}

function readCreative(r: Reader, raw: any): void {
  raw.groove = r.u8();
  raw.grooveAmt = r.u8();
  for (const t of raw.tracks) {
    const parts = r.u8();
    if (parts & Extra.Groove) { t.groove = r.u8(); t.grooveAmt = r.u8(); }
    if (parts & Extra.Arp) {
      const b = r.u8();
      t.arpMode = b & 7; t.arpRate = (b >> 3) & 3; t.arpOct = (b >> 5) + 1;
      t.arpGate = r.u8();
    }
  }
  const used = r.u8();
  for (let i = 0; i < NUM_PATTERNS; i++) {
    if (!(used & (1 << i))) continue;
    const pat = (raw.patterns ??= [])[i] ??= {};
    pat.mods = raw.tracks.map(() => {
      const row = new Array(MAX_STEPS).fill(0);
      for (let n = r.u8(); n > 0; n--) { const s = r.u8(); const m = r.vu(); if (s < MAX_STEPS) row[s] = m; }
      return row;
    });
  }
}

export function packProject(p: Project): Uint8Array {
  const w = new Writer();
  w.u8(VERSION);
  const part = (tag: Chunk, write: (w: Writer, p: Project) => void) => {
    const c = new Writer();
    write(c, p);
    w.chunk(tag, c);
  };
  part(Chunk.Settings, (c) => { writeSettings(c, p); c.str(p.name); });
  part(Chunk.Tracks, writeTracks);
  part(Chunk.Patterns, writePatterns);
  if (!isDefaultArrangement(p)) part(Chunk.Timeline, writeTimeline);
  if (p.tracks.some((t) => soundParts(t))) part(Chunk.Sound, writeSound);
  if (hasCreative(p)) part(Chunk.Creative, writeCreative);
  return w.bytes();
}

/** Version 1: one flat record, four patterns, and a pattern chain where the timeline is now. */
function unpackV1(r: Reader): any {
  const raw: any = {};
  readSettings(r, raw);
  readTracks(r, raw);
  const sl = r.u8();
  raw.song = [];
  for (let i = 0; i < sl; i++) raw.song.push(r.u8());
  raw.name = r.str();
  readPatterns(r, raw, V1_PATTERNS);
  return raw;
}

export function unpackProject(bytes: Uint8Array): Project {
  const r = new Reader(bytes);
  const version = r.u8();
  if (version === 1) return sanitize(unpackV1(r));
  if (version !== VERSION) throw new Error('unsupported version');
  const raw: any = {};
  while (r.more) {
    const tag = r.u8();
    const c = r.sub(r.vu());
    if (tag === Chunk.Settings) { readSettings(c, raw); raw.name = c.str(); }
    else if (tag === Chunk.Tracks) readTracks(c, raw);
    else if (tag === Chunk.Patterns) {
      if (!raw.tracks) throw new Error('patterns before tracks');
      readPatterns(c, raw, NUM_PATTERNS);
    } else if (tag === Chunk.Timeline) {
      if (!raw.tracks) throw new Error('timeline before tracks');
      readTimeline(c, raw);
    } else if (tag === Chunk.Sound) {
      if (!raw.tracks) throw new Error('sound before tracks');
      readSound(c, raw);
    } else if (tag === Chunk.Creative) {
      if (!raw.tracks) throw new Error('extras before tracks');
      readCreative(c, raw);
    }
  }
  if (!raw.tracks || raw.bpm === undefined) throw new Error('incomplete');
  // no timeline chunk means the untouched default: sanitize() builds exactly that
  return sanitize(raw);
}

function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad characters');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Project -> the string that goes after `#b=`. */
export function encodeBeat(p: Project): string {
  return toBase64Url(deflateSync(packProject(sanitize(p)), { level: 9 }));
}

/** The reverse. Returns null for anything that isn't a valid beat. */
export function decodeBeat(code: string): Project | null {
  try {
    if (!code || code.length > 20000) return null;
    const packed = inflateSync(fromBase64Url(code));
    if (packed.length > 100000) return null;
    return unpackProject(packed);
  } catch {
    return null;
  }
}

export function beatUrl(p: Project, base: string): string {
  return `${base.split('#')[0]}#${HASH_KEY}=${encodeBeat(p)}`;
}

/** Pull a beat out of a URL fragment such as "#b=…". */
export function beatFromHash(hash: string): Project | null {
  const m = new RegExp(`[#&]${HASH_KEY}=([^&]+)`).exec(hash);
  return m ? decodeBeat(m[1]) : null;
}
