// Standard MIDI Files, out and in. Export is format 1: one MIDI track per Loopwell track,
// drums on channel 10 with General MIDI notes. Import reads format 0 and 1.

import { barsUpTo, songEnd } from './arrange';
import { GM_NOTE, type Slot } from './kits';
import type { Played } from './played';
import {
  MAX_STEPS, MAX_TRACKS, NUM_PATTERNS, chainToClips, emptyArrangement, emptyProject, newPattern, newTrack, sanitize, synth, usesNotes, type Project,
} from './types';

const PPQ = 96;
const STEP = PPQ / 4;

interface Ev {
  tick: number;
  order: number; // note-offs sort before note-ons on the same tick
  data: number[];
}

function varlen(v: number): number[] {
  const out = [v & 127];
  while ((v >>= 7)) out.unshift((v & 127) | 128);
  return out;
}

function chunk(id: string, body: number[]): number[] {
  const n = body.length;
  return [...id].map((c) => c.charCodeAt(0)).concat([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255], body);
}

function track(name: string, evs: Ev[], endTick: number): number[] {
  const text = [...new TextEncoder().encode(name)];
  const body = [0, 0xff, 0x03, ...varlen(text.length), ...text];
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  for (const e of evs) {
    body.push(...varlen(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(...varlen(Math.max(0, endTick - last)), 0xff, 0x2f, 0);
  return chunk('MTrk', body);
}

const tempoEv = (tick: number, bpm: number): Ev => {
  const us = Math.round(60_000_000 / bpm);
  return { tick, order: 0, data: [0xff, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255] };
};
const sigEv = (tick: number, num: number, den: number): Ev =>
  ({ tick, order: 0, data: [0xff, 0x58, 4, num, Math.round(Math.log2(den)), 24, 8] });

/**
 * Write a .mid file. With `chain`, those patterns in order at the project
 * tempo; without it, the whole timeline with its tempo and time-signature changes.
 */
/**
 * With `played` (see played.ts) the file holds what the engine really plays: rolls, chance, grooves, arpeggios and
 * live code included, each note where it sounds. Without it, the grid as written, with swing.
 */
export function exportMidi(p: Project, chain?: number[], played?: Played[]): Uint8Array<ArrayBuffer> {
  const swingAmt = Math.round((p.swing / 100) * 0.5 * STEP);
  // every clip to play: [track, pattern, first step, length, pattern offset]
  const parts: [number, number, number, number, number][] = chain
    ? chain.flatMap((pi, bar) => p.tracks.map((_, ti): [number, number, number, number, number] => [ti, pi, bar * p.steps, p.steps, 0]))
    : p.arr.clips.map((c) => [c.track, c.pattern, c.start, c.len, c.offset]);
  const totalSteps = chain ? chain.length * p.steps : songEnd(p.arr) || p.steps;
  const total = totalSteps * STEP;
  const bars = chain ? null : barsUpTo(p, totalSteps);
  const odd = (step: number): boolean => {
    if (!bars) return (step & 1) === 1;
    let b = bars[0];
    for (const x of bars) if (x.start <= step) b = x; else break;
    return ((step - b.start) & 1) === 1;
  };

  const meta: Ev[] = [tempoEv(0, p.bpm)];
  if (chain) meta.push(sigEv(0, 4, 4));
  else {
    for (const e of p.arr.tempo) if (e.at < totalSteps) meta.push(tempoEv(e.at * STEP, e.bpm));
    let num = 0, den = 0;
    for (const b of bars!) if (b.num !== num || b.den !== den) { num = b.num; den = b.den; meta.push(sigEv(b.start * STEP, num, den)); }
    for (const m of p.arr.markers) {
      const text = [...new TextEncoder().encode(m.name)];
      if (m.at <= totalSteps) meta.push({ tick: m.at * STEP, order: 0, data: [0xff, 0x06, ...varlen(text.length), ...text] });
    }
  }
  const tracks = [track(p.name || 'Loopwell', meta, total)];

  let melodic = 0;
  p.tracks.forEach((t, ti) => {
    const evs: Ev[] = [];
    const drum = !usesNotes(t.kind);
    let ch = 9;
    if (!drum) { ch = melodic++; if (ch >= 9) ch++; }
    const drumNote = t.kind === 'dsyn' ? [36, 38, 42, 39][t.dsyn.model] : GM_NOTE[t.sample.split('/')[1] as Slot] ?? 60 + ti;
    if (played) {
      for (const n of played) {
        if (n.track !== ti) continue;
        const on = Math.round(n.step * STEP);
        const key = drum ? drumNote : t.kind === 'slice' ? Math.min(127, 36 + n.pitch) : n.pitch;
        const off = drum || !n.len ? on + STEP / 2 : Math.max(on + 1, Math.round((n.step + n.len) * STEP) - 1);
        evs.push({ tick: on, order: 1, data: [0x90 | ch, key & 127, Math.max(1, Math.min(127, n.vel))] });
        evs.push({ tick: Math.min(off, total), order: 0, data: [0x80 | ch, key & 127, 0] });
      }
      if (evs.length) tracks.push(track(t.name, evs, total));
      return;
    }
    for (const [track_, pi, start, len, offset] of parts) {
      if (track_ !== ti) continue;
      const pat = p.patterns[pi];
      if (!pat) continue;
      for (let k = 0; k < len; k++) {
        const step = start + k, local = (k + offset) % p.steps;
        const on = step * STEP + (odd(step) ? swingAmt : 0);
        if (drum) {
          const vel = pat.steps[ti][local];
          if (!vel) continue;
          evs.push({ tick: on, order: 1, data: [0x90 | ch, drumNote, vel] });
          evs.push({ tick: on + STEP / 2, order: 0, data: [0x80 | ch, drumNote, 0] });
        } else {
          for (const n of pat.notes[ti]) {
            if (n.s !== local) continue;
            const off = Math.max(on + 1, (step + Math.min(n.l, len - k)) * STEP - 1);
            // slices come out as notes from C1 up, one per slice
            const key = t.kind === 'slice' ? Math.min(127, 36 + n.p) : n.p;
            evs.push({ tick: on, order: 1, data: [0x90 | ch, key, n.v] });
            evs.push({ tick: off, order: 0, data: [0x80 | ch, key, 0] });
          }
        }
      }
    }
    if (evs.length) tracks.push(track(t.name, evs, total));
  });

  const header = chunk('MThd', [0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255]);
  return new Uint8Array(header.concat(...tracks));
}

// --- import ----------------------------------------------------------------

export interface MidiNote {
  /** In 16th-note steps from the start of the file (fractional). */
  at: number;
  len: number;
  pitch: number;
  vel: number;
}

export interface MidiPart {
  name: string;
  /** Channel 10: General MIDI drums. */
  drums: boolean;
  notes: MidiNote[];
}

export interface MidiSong {
  bpm: number;
  parts: MidiPart[];
  /** Length in steps, to the end of the last note. */
  steps: number;
}

/** Read a Standard MIDI File (format 0 or 1): the tempo it starts at, and the notes of each track and channel. */
export function importMidi(bytes: Uint8Array): MidiSong {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 14 || tag(0) !== 'MThd') throw new Error('This is not a MIDI file.');
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('This MIDI file keeps time in a way Loopwell can\'t read (SMPTE).');
  const ppq = division || 96;
  const toStep = (tick: number) => (tick / ppq) * 4;
  let bpm = 0;
  const parts = new Map<string, MidiPart>();
  let at = 8 + dv.getUint32(4), index = 0, end = 0;
  while (at + 8 <= bytes.length) {
    const id = tag(at), len = dv.getUint32(at + 4);
    const stop = Math.min(bytes.length, at + 8 + len);
    let o = at + 8;
    at = stop;
    if (id !== 'MTrk') continue;
    let tick = 0, status = 0, name = '';
    const open = new Map<number, { tick: number; vel: number }[]>(); // channel*128+pitch -> notes sounding
    const read = () => { let v = 0; for (let i = 0; i < 4 && o < stop; i++) { const b = bytes[o++]; v = (v << 7) | (b & 127); if (b < 128) break; } return v; };
    const part = (ch: number) => {
      const key = `${index}:${ch}`;
      let p = parts.get(key);
      if (!p) { p = { name: '', drums: ch === 9, notes: [] }; parts.set(key, p); }
      return p;
    };
    while (o < stop) {
      tick += read();
      let b = bytes[o];
      if (b & 0x80) { status = b; o++; } // otherwise running status: the last one again
      if (status === 0xff) {
        const type = bytes[o++], n = read();
        if (type === 0x51 && n === 3 && !bpm) bpm = 60_000_000 / ((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]);
        else if (type === 0x03 && !name) name = new TextDecoder().decode(bytes.subarray(o, o + n)).trim();
        o += n;
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        o += read();
        status = 0;
      } else {
        const type = status & 0xf0, ch = status & 15;
        const d1 = bytes[o++];
        const d2 = type === 0xc0 || type === 0xd0 ? 0 : bytes[o++];
        b = ch * 128 + d1;
        if (type === 0x90 && d2 > 0) {
          const list = open.get(b) ?? [];
          list.push({ tick, vel: d2 });
          open.set(b, list);
        } else if (type === 0x80 || type === 0x90) {
          const on = open.get(b)?.shift();
          if (on) {
            part(ch).notes.push({ at: toStep(on.tick), len: Math.max(0.25, toStep(tick - on.tick)), pitch: d1, vel: on.vel });
            end = Math.max(end, toStep(tick));
          }
        }
      }
    }
    for (const [key, p] of parts) if (key.startsWith(`${index}:`)) p.name = name;
    index++;
  }
  const list = [...parts.values()].filter((p) => p.notes.length);
  for (const p of list) p.notes.sort((a, b) => a.at - b.at || a.pitch - b.pitch);
  if (!list.length) throw new Error('That MIDI file has no notes in it.');
  return { bpm: Math.max(40, Math.min(240, Math.round(bpm || 120))), parts: list, steps: Math.ceil(end) };
}

// General MIDI drum notes -> the kit slot that plays them
const DRUM_SLOT: Record<number, Slot> = {
  35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'hat', 44: 'hat', 46: 'open',
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 49: 'crash', 51: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 59: 'crash',
};

export interface MidiImport {
  project: Project;
  /** Bars of the file that made it in, and how many it had. */
  bars: number;
  totalBars: number;
  /** Parts that had to be left out because all eight tracks were taken. */
  skipped: number;
}

/**
 * Lay a MIDI file out as a beat: drums on drum tracks (one per kind of drum), every other part on a synth track,
 * each bar a pattern, the bars in order on the timeline. Bars that are the same share a pattern, so a song with a
 * lot of repetition fits; it stops at the first bar that would need a ninth pattern.
 */
export function midiToProject(song: MidiSong, kit = 'boom'): MidiImport {
  const p = emptyProject();
  p.bpm = song.bpm;
  p.tracks = [];
  interface Lane { steps?: Map<number, number>; notes?: MidiNote[] }
  const lanes: Lane[] = [];
  let skipped = 0;
  const add = (t: Project['tracks'][number], lane: Lane): boolean => {
    if (p.tracks.length >= MAX_TRACKS) return false;
    p.tracks.push(t);
    lanes.push(lane);
    return true;
  };
  for (const part of song.parts) {
    if (part.drums) {
      const bySlot = new Map<Slot, Map<number, number>>();
      for (const n of part.notes) {
        const slot = DRUM_SLOT[n.pitch] ?? 'perc';
        const m = bySlot.get(slot) ?? new Map<number, number>();
        const s = Math.round(n.at);
        m.set(s, Math.max(m.get(s) ?? 0, n.vel));
        bySlot.set(slot, m);
      }
      for (const [slot, steps] of bySlot) {
        if (!add(newTrack('drum', p.tracks.length % 8, slot.toUpperCase(), `${kit}/${slot}`), { steps })) skipped++;
      }
    } else {
      const mean = part.notes.reduce((a, n) => a + n.pitch, 0) / part.notes.length;
      const t = newTrack('synth', p.tracks.length % 8, (part.name || (mean < 50 ? 'BASS' : 'SYNTH')).slice(0, 12).toUpperCase());
      t.note = Math.round(mean / 12) * 12;
      if (mean < 50) t.synth = synth({ wave: 0, cutoff: 46, reso: 40, env: 70, decay: 46, sustain: 30, release: 20 });
      if (!add(t, { notes: part.notes })) skipped++;
    }
  }
  const nt = p.tracks.length;
  const totalBars = Math.max(1, Math.ceil(song.steps / 16));
  const made: string[] = [];
  const chain: number[] = [];
  p.patterns = Array.from({ length: NUM_PATTERNS }, () => newPattern(nt));
  for (let bar = 0; bar < totalBars && bar < 256; bar++) {
    const pat = newPattern(nt);
    lanes.forEach((lane, t) => {
      if (lane.steps) {
        for (const [s, v] of lane.steps) if (s >= bar * 16 && s < bar * 16 + 16) pat.steps[t][s - bar * 16] = v;
      } else {
        for (const n of lane.notes!) {
          const s = Math.round(n.at);
          if (s < bar * 16 || s >= bar * 16 + 16) continue;
          pat.notes[t].push({ s: s - bar * 16, l: Math.max(1, Math.min(MAX_STEPS, Math.round(n.len))), p: n.pitch, v: Math.max(1, n.vel) });
        }
      }
    });
    const key = JSON.stringify(pat);
    let i = made.indexOf(key);
    if (i < 0) {
      if (made.length >= NUM_PATTERNS) break;
      i = made.push(key) - 1;
      p.patterns[i] = pat;
    }
    chain.push(i);
  }
  p.arr = { ...emptyArrangement(nt, 16), clips: chainToClips(chain, nt, 16) };
  p.songMode = chain.length > 1;
  return { project: sanitize(p), bars: chain.length, totalBars, skipped };
}
