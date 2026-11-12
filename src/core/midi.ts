// Standard MIDI File export (format 1). One MIDI track per Loopwell track,
// drums on channel 10 with General MIDI notes.

import { barsUpTo, songEnd } from './arrange';
import { GM_NOTE, type Slot } from './kits';
import type { Project } from './types';

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
export function exportMidi(p: Project, chain?: number[]): Uint8Array<ArrayBuffer> {
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
    const drum = t.kind === 'drum';
    let ch = 9;
    if (!drum) { ch = melodic++; if (ch >= 9) ch++; }
    const drumNote = GM_NOTE[t.sample.split('/')[1] as Slot] ?? 60 + ti;
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
            evs.push({ tick: on, order: 1, data: [0x90 | ch, n.p, n.v] });
            evs.push({ tick: off, order: 0, data: [0x80 | ch, n.p, 0] });
          }
        }
      }
    }
    if (evs.length) tracks.push(track(t.name, evs, total));
  });

  const header = chunk('MThd', [0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255]);
  return new Uint8Array(header.concat(...tracks));
}
