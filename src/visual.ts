// One requestAnimationFrame loop for everything that moves with the music.
// Components subscribe and poke the DOM directly, so playback never triggers
// a framework re-render at step rate.

import { audio, type Playhead } from './audio/host';
import { trackStepAt } from './core/arrange';
import { usesNotes } from './core/types';
import { app } from './state.svelte';

/**
 * Should things move? Not when the system asks for reduced motion, nor when it has been switched off in the
 * settings. Sound and the playhead carry on; the bounces, flashes and pulses that go with them don't.
 */
const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const lively = (): boolean => !(reduced?.matches || document.documentElement.dataset.calm !== undefined);

/**
 * A meter bar's transform for a level, or null if it would look the same as it does now. Writing a style
 * only when the bar would actually move by a pixel keeps most frames free of any work at all.
 */
/**
 * Flash an element by fading it out from `level`. Each element keeps one animation that is played again for every
 * hit: making a new one each time (dozens a second on a busy beat) is what costs.
 */
const fades = new WeakMap<Element, { anim: Animation; level: number }>();
export function fade(el: Element, level: number, duration = 320): void {
  if (!lively()) return;
  const lv = Math.round(level * 8) / 8; // near enough, and it means the keyframes rarely have to change
  const had = fades.get(el);
  if (!had) { fades.set(el, { anim: el.animate([{ opacity: lv }, { opacity: 0 }], { duration, easing: 'ease-out' }), level: lv }); return; }
  if (had.level !== lv) { (had.anim.effect as KeyframeEffect).setKeyframes([{ opacity: lv }, { opacity: 0 }]); had.level = lv; }
  had.anim.cancel();
  had.anim.play();
}

/** Counts frames, so that things which don't need all sixty a second can take turns. */
export let frameNo = 0;

export function meterScale(el: HTMLElement, level: number, axis: 'X' | 'Y'): void {
  const v = Math.round(Math.min(1, level) * 200) / 200;
  const was = (el as HTMLElement & { _lv?: number })._lv;
  if (was === v) return;
  (el as HTMLElement & { _lv?: number })._lv = v;
  el.style.transform = `scale${axis}(${v.toFixed(3)})`;
}

type FrameFn = (head: Playhead | null, stepChanged: boolean) => void;
type FlashFn = (track: number, vel: number, sequenced: boolean) => void;

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

/** Light up a track's pad. `sequenced` is true for a hit the pattern played, false for a finger, a key or MIDI. */
export function flash(track: number, vel: number, sequenced = false): void {
  for (const fn of flashes) fn(track, vel, sequenced);
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
        if (v) flash(t, v, true);
      }
    }
  } else lastStep = lastPat = -1;
  frameNo++;
  for (const fn of frames) fn(head, changed);
  requestAnimationFrame(tick);
}

let started = false;
export function startVisuals(): void {
  if (started) return;
  started = true;
  requestAnimationFrame(tick);
}
