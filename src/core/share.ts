// Share links. The whole beat is packed into a compact binary layout,
// deflated, and base64url-encoded into the URL fragment. Nothing is uploaded
// anywhere. Built-in samples are stored as a one-byte reference; samples you
// dropped in yourself cannot travel in a link (use a project file for those).

import { deflateSync, inflateSync } from 'fflate';
import { KITS, SLOTS, isBuiltin } from './kits';
import { DEFAULT_VEL, MAX_STEPS, NUM_PATTERNS, sanitize, type Project } from './types';

const VERSION = 1;
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
  str(): string {
    const len = this.u8();
    if (this.n + len > this.buf.length) throw new Error('truncated');
    const s = new TextDecoder().decode(this.buf.subarray(this.n, this.n + len));
    this.n += len;
    return s;
  }
}

export function packProject(p: Project): Uint8Array {
  const w = new Writer();
  w.u8(VERSION);
  w.u8(p.bpm - 40);
  w.u8(p.swing);
  w.u8((p.steps === 32 ? 1 : 0) | (p.songMode ? 2 : 0) | (p.scaleLock ? 4 : 0) | (p.fx.compOn ? 8 : 0));
  w.u8((p.scaleRoot << 4) | p.scaleType);
  w.u8(p.master);
  const f = p.fx;
  for (const v of [f.revSize, f.revDamp, f.revLevel, f.dlyTime, f.dlyFb, f.dlyLevel, f.filter + 64, f.filterRes, f.compThresh, f.compRatio, f.compMakeup]) w.u8(v);

  w.u8(p.tracks.length);
  for (const t of p.tracks) {
    const builtin = isBuiltin(t.sample);
    const synth = t.kind === 'synth';
    w.u8((synth ? 1 : 0) | (t.mute ? 2 : 0) | (t.solo ? 4 : 0) | ((t.color & 7) << 3) | (!synth && !builtin ? 64 : 0));
    w.str(t.name);
    if (synth) {
      const s = t.synth;
      for (const v of [s.wave, s.cutoff, s.reso, s.env, s.attack, s.decay, s.sustain, s.release, t.note]) w.u8(v);
    } else {
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

  w.u8(p.song.length);
  for (const s of p.song) w.u8(s);
  w.str(p.name);

  const used = p.patterns.map((pat, i) =>
    p.tracks.some((t, ti) => (t.kind === 'synth' ? pat.notes[ti].length > 0 : pat.steps[ti].some((v) => v > 0))) ? 1 << i : 0);
  w.u8(used.reduce((a, b) => a | b, 0));
  p.patterns.forEach((pat, i) => {
    if (!used[i]) return;
    p.tracks.forEach((t, ti) => {
      if (t.kind === 'synth') {
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
  return w.bytes();
}

export function unpackProject(bytes: Uint8Array): Project {
  const r = new Reader(bytes);
  if (r.u8() !== VERSION) throw new Error('unsupported version');
  const raw: any = { v: 1 };
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
  const nt = r.u8();
  if (nt < 1 || nt > 8) throw new Error('bad track count');
  raw.tracks = [];
  for (let i = 0; i < nt; i++) {
    const tf = r.u8();
    const t: any = { kind: tf & 1 ? 'synth' : 'drum', mute: !!(tf & 2), solo: !!(tf & 4), color: (tf >> 3) & 7 };
    t.name = r.str();
    if (tf & 1) {
      t.synth = { wave: r.u8(), cutoff: r.u8(), reso: r.u8(), env: r.u8(), attack: r.u8(), decay: r.u8(), sustain: r.u8(), release: r.u8() };
      t.note = r.u8();
    } else {
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
  const sl = r.u8();
  raw.song = [];
  for (let i = 0; i < sl; i++) raw.song.push(r.u8());
  raw.name = r.str();
  const used = r.u8();
  raw.patterns = [];
  for (let i = 0; i < NUM_PATTERNS; i++) {
    const pat: any = { steps: [], notes: [] };
    for (let ti = 0; ti < nt; ti++) {
      const steps = new Array(MAX_STEPS).fill(0);
      const notes: any[] = [];
      if (used & (1 << i)) {
        if (raw.tracks[ti].kind === 'synth') {
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
