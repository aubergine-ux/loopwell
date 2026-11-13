// Learn mode, the parts that are plain data and arithmetic: the beats to
// recreate, the starting points for lessons, and how close an attempt is.

import { beat, type Pat } from './demos';
import { newPattern, usesNotes, type Project } from './types';

export interface TrackScore {
  track: number;
  name: string;
  /** In the target and in the attempt. */
  right: number;
  /** In the target only. */
  missing: number;
  /** In the attempt only. */
  extra: number;
  /** Of the missing: a note is on the right step, but it is the wrong note. */
  wrongNote: number;
}

export interface Closeness {
  /** 0..1: 1 is the same beat. */
  score: number;
  tracks: TrackScore[];
  right: number;
  missing: number;
  extra: number;
}

/** What a track plays in a pattern, as a set of "step" or "step:pitch". Loudness and length are not judged. */
function events(p: Project, pattern: number, t: number): Set<string> {
  const out = new Set<string>();
  const pat = p.patterns[pattern], tr = p.tracks[t];
  if (!pat || !tr) return out;
  if (usesNotes(tr.kind)) { for (const n of pat.notes[t] ?? []) if (n.s < p.steps) out.add(`${n.s}:${n.p}`); }
  else (pat.steps[t] ?? []).forEach((v, s) => { if (v > 0 && s < p.steps) out.add(String(s)); });
  return out;
}

/**
 * How close `mine` is to `target`, pattern against pattern. Every hit and note counts once; the score is the
 * share that match, with a wrong extra hit costing as much as a missing one (so filling every step earns nothing).
 */
export function closeness(target: Project, mine: Project, pattern = 0, minePattern = pattern): Closeness {
  const tracks: TrackScore[] = [];
  let right = 0, missing = 0, extra = 0;
  for (let t = 0; t < target.tracks.length; t++) {
    const want = events(target, pattern, t), got = events(mine, minePattern, t);
    if (!want.size && !got.size) continue;
    const s: TrackScore = { track: t, name: target.tracks[t].name, right: 0, missing: 0, extra: 0, wrongNote: 0 };
    const gotSteps = new Set([...got].map((e) => e.split(':')[0]));
    for (const e of want) {
      if (got.has(e)) s.right++;
      else { s.missing++; if (e.includes(':') && gotSteps.has(e.split(':')[0])) s.wrongNote++; }
    }
    for (const e of got) if (!want.has(e)) s.extra++;
    right += s.right; missing += s.missing; extra += s.extra;
    tracks.push(s);
  }
  const all = 2 * right + missing + extra;
  return { score: all ? (2 * right) / all : 1, tracks, right, missing, extra };
}

/** In words, what is still off on a track. */
export function hint(s: TrackScore): string {
  if (!s.missing && !s.extra) return 'spot on';
  const parts: string[] = [];
  const plain = s.missing - s.wrongNote;
  if (plain) parts.push(`${plain} missing`);
  if (s.wrongNote) parts.push(`${s.wrongNote} on the right step but the wrong note`);
  if (s.extra - s.wrongNote > 0) parts.push(`${s.extra - s.wrongNote} too many`);
  return parts.join(', ');
}

export const PASS = 0.9;

export interface Challenge {
  id: string;
  name: string;
  blurb: string;
  level: 1 | 2 | 3;
  make: () => Project;
}

const one = (name: string, kit: string, bpm: number, pat: Pat, edit: (p: Project) => void = () => {}): Project =>
  beat(name, kit, [pat], (p) => { p.bpm = bpm; edit(p); });

export const CHALLENGES: Challenge[] = [
  {
    id: 'floor', name: 'Four on the floor', level: 1, blurb: 'Kick, clap and off-beat hats: the heartbeat of house.',
    make: () => one('Four on the floor', 'boom', 124, { kick: 'x---x---x---x---', clap: '----x-------x---', hat: '--x---x---x---x-' }),
  },
  {
    id: 'boombap', name: 'Boom bap', level: 1, blurb: 'A kick that skips and a snare that doesn\'t.',
    make: () => one('Boom bap', 'dust', 90, { kick: 'x-----x---x-----', snare: '----x-------x---', hat: 'x-x-x-x-x-x-x-x-' }, (p) => { p.swing = 30; }),
  },
  {
    id: 'bounce', name: 'Trap bounce', level: 2, blurb: 'Listen for where the kick lands late, and the hat that opens.',
    make: () => one('Trap bounce', 'punch', 140, { kick: 'x-----x--x----x-', clap: '--------x-------', hat: 'x-x-x-x-x-xxx-x-', open: '------x---------', perc: '---x------x-----' }),
  },
  {
    id: 'bassline', name: 'Drums and a bassline', level: 3, blurb: 'Now by ear: four bass notes over a simple beat. The song is in A minor.',
    make: () => one('Drums and a bassline', 'boom', 110, {
      kick: 'x---x---x---x---', clap: '----x-------x---', hat: 'x-x-x-x-x-x-x-x-',
      bass: [[0, 33, 3], [4, 33, 3], [8, 36, 3], [12, 31, 3]],
    }, (p) => { p.scaleRoot = 9; p.scaleType = 1; p.tracks[6].note = 33; }),
  },
];

/** The same kit, tempo and sounds as a challenge's beat, with nothing played yet. */
export function blankOf(target: Project, name: string): Project {
  const p: Project = JSON.parse(JSON.stringify(target));
  p.name = name;
  p.patterns = p.patterns.map(() => newPattern(p.tracks.length));
  p.songMode = false;
  return p;
}
