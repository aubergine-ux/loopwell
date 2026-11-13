// One requestAnimationFrame loop for everything that moves with the music.
// Components subscribe and poke the DOM directly, so playback never triggers
// a framework re-render at step rate.

import { audio, type Playhead } from './audio/host';
import { trackStepAt } from './core/arrange';
import { usesNotes } from './core/types';
import { app } from './state.svelte';

type FrameFn = (head: Playhead | null, stepChanged: boolean) => void;
type FlashFn = (track: number, vel: number) => void;

const frames = new Set<FrameFn>();
const flashes = new Set<FlashFn>();
let lastStep = -1, lastPat = -1, lastSong = -1;

export function onFrame(fn: FrameFn): () => void {
  frames.add(fn);
  return () => frames.delete(fn);
}

export function onFlash(fn: FlashFn): () => void {
  flashes.add(fn);
  return () => flashes.delete(fn);
}

/** Light up a track's pad (sequenced hit, finger, key or MIDI). */
export function flash(track: number, vel: number): void {
  for (const fn of flashes) fn(track, vel);
}

// What the pattern grid should show. While the song plays, that is the pattern
// and step the selected track's clip is on.
const view: Playhead = { step: 0, pattern: 0, song: -1 };

function hits(p: typeof app.project, t: number, pattern: number, step: number): number {
  const pat = p.patterns[pattern];
  if (!pat) return 0;
  if (!usesNotes(p.tracks[t].kind)) return pat.steps[t]?.[step] ?? 0;
  const ns = pat.notes[t];
  if (ns) for (let i = 0; i < ns.length; i++) if (ns[i].s === step) return ns[i].v;
  return 0;
}

function tick(): void {
  const raw = audio.playhead();
  let head: Playhead | null = null;
  let changed = false;
  if (raw) {
    const p = app.project;
    head = view;
    view.song = raw.song;
    if (raw.song < 0) { view.step = raw.step; view.pattern = raw.pattern; }
    else {
      const at = trackStepAt(p, app.sel, raw.song);
      view.step = at ? at.local : raw.song % p.steps;
      view.pattern = at ? at.pattern : app.pat;
    }
    changed = raw.step !== lastStep || raw.pattern !== lastPat || (raw.song < 0) !== (lastSong < 0);
    if (changed) {
      lastStep = raw.step;
      lastPat = raw.pattern;
      lastSong = raw.song;
      if (app.pat !== view.pattern) app.pat = view.pattern;
      if (app.queued === view.pattern) app.queued = -1;
      for (let t = 0; t < p.tracks.length; t++) {
        let v = 0;
        if (raw.song < 0) v = hits(p, t, raw.pattern, raw.step);
        else {
          const at = trackStepAt(p, t, raw.song);
          if (at) v = hits(p, t, at.pattern, at.local);
        }
        if (v) flash(t, v);
      }
    }
  } else lastStep = lastPat = -1;
  for (const fn of frames) fn(head, changed);
  requestAnimationFrame(tick);
}

let started = false;
export function startVisuals(): void {
  if (started) return;
  started = true;
  requestAnimationFrame(tick);
}
