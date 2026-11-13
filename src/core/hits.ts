// When each track plays, in seconds: the same timing the engine uses, worked
// out from the project alone. The video export lights its pads from this.

import { songEnd, stepToSeconds, trackStepAt } from './arrange';
import { usesNotes, type Project } from './types';

export interface Hit {
  /** Seconds from the start. */
  t: number;
  track: number;
  vel: number;
}

/** Every hit and note start, in order. With `chain`, those patterns one after another; without, the song timeline. */
export function hitTimeline(p: Project, chain?: number[]): Hit[] {
  const out: Hit[] = [];
  const at = (pattern: number, local: number, track: number): number => {
    const pat = p.patterns[pattern];
    if (!pat) return 0;
    if (!usesNotes(p.tracks[track].kind)) return pat.steps[track]?.[local] ?? 0;
    let v = 0;
    for (const n of pat.notes[track] ?? []) if (n.s === local && n.v > v) v = n.v;
    return v;
  };
  if (chain) {
    const step = 15 / p.bpm;
    chain.forEach((pattern, bar) => {
      for (let s = 0; s < p.steps; s++) {
        for (let t = 0; t < p.tracks.length; t++) {
          const vel = at(pattern, s, t);
          if (vel && !p.tracks[t].mute) out.push({ t: (bar * p.steps + s) * step, track: t, vel });
        }
      }
    });
    return out;
  }
  const end = songEnd(p.arr);
  for (let s = 0; s < end; s++) {
    for (let t = 0; t < p.tracks.length; t++) {
      const here = trackStepAt(p, t, s);
      if (!here || p.tracks[t].mute) continue;
      const vel = at(here.pattern, here.local, t);
      if (vel) out.push({ t: stepToSeconds(p, s), track: t, vel });
    }
  }
  return out;
}
