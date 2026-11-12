// Timeline maths shared by the engine, the exporters and the interface.
// Positions are 16th-note steps from the start of the song.

import { MAX_SONG_STEPS, resolveOverlaps, type Arrangement, type AutoPoint, type Clip, type Project } from './types';

export const stepsPerBar = (num: number, den: number) => Math.max(1, Math.round((num * 16) / den));

/** First step after the last clip (0 for an empty timeline). */
export function songEnd(a: Arrangement): number {
  let end = 0;
  for (const c of a.clips) if (c.start + c.len > end) end = c.start + c.len;
  return end;
}

export function clipAt(clips: Clip[], track: number, step: number): Clip | null {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.track === track && step >= c.start && step < c.start + c.len) return c;
  }
  return null;
}

/** What a track is playing at a song step: which pattern, and which step of it. */
export function trackStepAt(p: Project, track: number, step: number): { pattern: number; local: number; clip: Clip } | null {
  const c = clipAt(p.arr.clips, track, step);
  return c ? { pattern: c.pattern, local: (step - c.start + c.offset) % p.steps, clip: c } : null;
}

export function tempoAt(p: Project, step: number): number {
  let bpm = p.bpm;
  for (const e of p.arr.tempo) if (e.at <= step) bpm = e.bpm; else break;
  return bpm;
}

export interface Bar { start: number; len: number; num: number; den: number; index: number }

/** Bar lines from the start up to (and including the bar containing) `upTo`. A signature change waits for the next bar line. */
export function barsUpTo(p: Project, upTo: number): Bar[] {
  const bars: Bar[] = [];
  const sigs = p.arr.sigs;
  let num = 4, den = 4, k = 0, start = 0;
  const end = Math.min(upTo, MAX_SONG_STEPS);
  while (start <= end && bars.length < 4096) {
    while (k < sigs.length && sigs[k].at <= start) { num = sigs[k].num; den = sigs[k].den; k++; }
    const len = stepsPerBar(num, den);
    bars.push({ start, len, num, den, index: bars.length });
    start += len;
  }
  return bars;
}

/** Start of the bar containing `step`. Allocates nothing: the audio thread calls it every step. */
export function barStart(p: Project, step: number): number {
  const sigs = p.arr.sigs;
  if (!sigs.length) return step - (step % 16);
  let num = 4, den = 4, k = 0, start = 0;
  for (;;) {
    while (k < sigs.length && sigs[k].at <= start) { num = sigs[k].num; den = sigs[k].den; k++; }
    const len = stepsPerBar(num, den);
    if (start + len > step) return start;
    start += len;
  }
}

export function barAt(p: Project, step: number): Bar {
  const bars = barsUpTo(p, step);
  return bars[bars.length - 1];
}

/** "bar.beat.sixteenth" as shown on the display. */
export function posLabel(p: Project, step: number): string {
  const b = barAt(p, step);
  const inBar = step - b.start;
  const beat = Math.max(1, Math.round(16 / b.den));
  return `${b.index + 1}.${Math.floor(inBar / beat) + 1}.${(inBar % beat) + 1}`;
}

/** Seconds from the start of the song to `step`, following every tempo change. */
export function stepToSeconds(p: Project, step: number): number {
  let t = 0, at = 0, bpm = p.bpm;
  for (const e of p.arr.tempo) {
    if (e.at >= step) break;
    t += ((e.at - at) * 15) / bpm;
    at = e.at;
    bpm = e.bpm;
  }
  return t + ((step - at) * 15) / bpm;
}

/** Value of a drawn curve at a (fractional) step. Flat before the first and after the last point. */
export function curveAt(points: AutoPoint[], step: number): number {
  const n = points.length;
  if (step <= points[0].t) return points[0].v;
  if (step >= points[n - 1].t) return points[n - 1].v;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= step) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  return a.v + ((b.v - a.v) * (step - a.t)) / (b.t - a.t);
}

/** Put a clip on the timeline, trimming or splitting whatever it lands on. */
export function placeClip(a: Arrangement, clip: Clip, steps: number): void {
  a.clips = resolveOverlaps([...a.clips.filter((c) => c.id !== clip.id), clip], steps);
}

/** Is this the untouched timeline every new beat starts with (one clip of pattern A per track)? */
export function isDefaultArrangement(p: Project): boolean {
  const a = p.arr;
  if (a.lanes.length || a.tempo.length || a.sigs.length || a.markers.length || a.loopOn) return false;
  if (a.clips.length !== p.tracks.length) return false;
  const seen = new Set<number>();
  for (const c of a.clips) {
    if (c.pattern !== 0 || c.start !== 0 || c.len !== p.steps || c.offset !== 0 || seen.has(c.track)) return false;
    seen.add(c.track);
  }
  return true;
}
