// Standard MIDI File export (format 1). One MIDI track per Loopwell track,
// drums on channel 10 with General MIDI notes.

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

/** Render `chain` (pattern indices in play order) to a .mid file. */
export function exportMidi(p: Project, chain: number[]): Uint8Array<ArrayBuffer> {
  const swing = (step: number) => (step & 1 ? Math.round((p.swing / 100) * 0.5 * STEP) : 0);
  const total = chain.length * p.steps * STEP;
  const usPerBeat = Math.round(60_000_000 / p.bpm);
  const tempo: Ev[] = [
    { tick: 0, order: 0, data: [0xff, 0x51, 3, usPerBeat >> 16, (usPerBeat >> 8) & 255, usPerBeat & 255] },
    { tick: 0, order: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
  ];
  const tracks = [track(p.name || 'Loopwell', tempo, total)];

  let melodic = 0;
  p.tracks.forEach((t, ti) => {
    const evs: Ev[] = [];
    const drum = t.kind === 'drum';
    let ch = 9;
    if (!drum) { ch = melodic++; if (ch >= 9) ch++; }
    const drumNote = GM_NOTE[t.sample.split('/')[1] as Slot] ?? 60 + ti;
    chain.forEach((pi, bar) => {
      const pat = p.patterns[pi];
      if (!pat) return;
      const base = bar * p.steps * STEP;
      if (drum) {
        for (let s = 0; s < p.steps; s++) {
          const vel = pat.steps[ti][s];
          if (!vel) continue;
          const on = base + s * STEP + swing(s);
          evs.push({ tick: on, order: 1, data: [0x90 | ch, drumNote, vel] });
          evs.push({ tick: on + STEP / 2, order: 0, data: [0x80 | ch, drumNote, 0] });
        }
      } else {
        for (const n of pat.notes[ti]) {
          if (n.s >= p.steps) continue;
          const on = base + n.s * STEP + swing(n.s);
          const off = Math.max(on + 1, base + (n.s + n.l) * STEP - 1);
          evs.push({ tick: on, order: 1, data: [0x90 | ch, n.p, n.v] });
          evs.push({ tick: off, order: 0, data: [0x80 | ch, n.p, 0] });
        }
      }
    });
    if (evs.length) tracks.push(track(t.name, evs, total));
  });

  const header = chunk('MThd', [0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255]);
  return new Uint8Array(header.concat(...tracks));
}
