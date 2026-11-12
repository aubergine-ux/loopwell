// One requestAnimationFrame loop for everything that moves with the music.
// Components subscribe and poke the DOM directly, so playback never triggers
// a framework re-render at step rate.

import { audio, type Playhead } from './audio/host';
import { app } from './state.svelte';

type FrameFn = (head: Playhead | null, stepChanged: boolean) => void;
type FlashFn = (track: number, vel: number) => void;

const frames = new Set<FrameFn>();
const flashes = new Set<FlashFn>();
let lastStep = -1, lastPat = -1;

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

function tick(): void {
  const head = audio.playhead();
  const changed = !!head && (head.step !== lastStep || head.pattern !== lastPat);
  if (head && changed) {
    lastStep = head.step;
    lastPat = head.pattern;
    if (app.pat !== head.pattern) app.pat = head.pattern;
    if (app.queued === head.pattern) app.queued = -1;
    if (app.songPos !== head.songPos) app.songPos = head.songPos;
    const p = app.project, pat = p.patterns[head.pattern];
    if (pat) {
      for (let t = 0; t < p.tracks.length; t++) {
        if (p.tracks[t].kind === 'drum') {
          const v = pat.steps[t]?.[head.step];
          if (v) flash(t, v);
        } else {
          const ns = pat.notes[t];
          if (ns) for (let i = 0; i < ns.length; i++) if (ns[i].s === head.step) { flash(t, ns[i].v); break; }
        }
      }
    }
  }
  if (!head) lastStep = lastPat = -1;
  for (const fn of frames) fn(head, changed);
  requestAnimationFrame(tick);
}

let started = false;
export function startVisuals(): void {
  if (started) return;
  started = true;
  requestAnimationFrame(tick);
}
