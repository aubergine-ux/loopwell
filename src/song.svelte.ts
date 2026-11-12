// Everything the timeline can do to the arrangement.

import { checkpoint, setView } from './actions.svelte';
import { audio } from './audio/host';
import { barAt, barsUpTo, placeClip, songEnd, tempoAt } from './core/arrange';
import { paramDef, paramsFor } from './core/params';
import {
  MAX_CLIPS, MAX_EVENTS, MAX_LANES, MAX_POINTS, MAX_SONG_STEPS, clamp, newId,
  type AutoLane, type Clip,
} from './core/types';
import { app } from './state.svelte';

const arr = () => app.project.arr;
export const clipById = (id: string | null) => (id ? arr().clips.find((c) => c.id === id) : undefined);

/** Move the cursor; if the song is playing it jumps there. */
export function seek(step: number): void {
  app.cursor = clamp(Math.round(step), 0, MAX_SONG_STEPS - 1);
  audio.seek(app.cursor);
}

/** Put a clip of `pattern` on a track. It trims or splits anything it lands on. */
export function addClip(track: number, start: number, pattern = app.pat, len = app.project.steps): Clip | null {
  const a = arr();
  if (a.clips.length >= MAX_CLIPS || track < 0 || track >= app.project.tracks.length) return null;
  start = clamp(start, 0, MAX_SONG_STEPS - 1);
  const clip: Clip = { id: newId(), track, pattern, start, len: clamp(len, 1, MAX_SONG_STEPS - start), offset: 0 };
  placeClip(a, clip, app.project.steps);
  app.clip = clip.id;
  checkpoint();
  return clip;
}

/** Settle a clip after a drag or resize: whatever it now overlaps makes room. */
export function commitClip(id: string): void {
  const a = arr();
  const c = a.clips.find((x) => x.id === id);
  if (c) placeClip(a, $state.snapshot(c) as Clip, app.project.steps);
  checkpoint();
}

export function deleteClip(id: string): void {
  const a = arr();
  a.clips = a.clips.filter((c) => c.id !== id);
  if (app.clip === id) app.clip = null;
  checkpoint();
}

/** Copy a clip to right after itself (or to `start`), ready to be dragged somewhere else. */
export function duplicateClip(id: string, start?: number, track?: number): Clip | null {
  const c = clipById(id);
  if (!c) return null;
  const at = start ?? c.start + c.len;
  if (at >= MAX_SONG_STEPS || arr().clips.length >= MAX_CLIPS) return null;
  const copy: Clip = { ...($state.snapshot(c) as Clip), id: newId(), start: at, track: track ?? c.track };
  copy.len = Math.min(copy.len, MAX_SONG_STEPS - at);
  placeClip(arr(), copy, app.project.steps);
  app.clip = copy.id;
  checkpoint();
  return copy;
}

/** Repeat a clip's pattern: stretch it by one more pass. */
export function loopClip(id: string): void {
  const c = clipById(id);
  if (!c) return;
  c.len = Math.min(MAX_SONG_STEPS - c.start, c.len + app.project.steps);
  commitClip(id);
}

/** Open the clip's pattern in the pattern view, on its track. */
export function editClip(id: string): void {
  const c = clipById(id);
  if (!c) return;
  app.sel = c.track;
  app.pat = c.pattern;
  setView(false);
}

// --- automation ---

export function addLane(track: number, param?: string): AutoLane | null {
  const a = arr();
  if (a.lanes.length >= MAX_LANES) return null;
  const taken = new Set(a.lanes.filter((l) => l.track === track).map((l) => l.param));
  const def = param ? paramDef(param) : paramsFor(app.project, track).find((d) => !taken.has(d.id));
  if (!def || taken.has(def.id)) return null;
  const lane: AutoLane = { id: newId(), track, param: def.id, on: true, points: [] };
  a.lanes.push(lane);
  return lane;
}

export function removeLane(id: string): void {
  arr().lanes = arr().lanes.filter((l) => l.id !== id);
}

/** Point a lane at another knob. Its curve is rescaled to the new knob's range. */
export function setLaneParam(id: string, param: string): void {
  const a = arr();
  const lane = a.lanes.find((l) => l.id === id);
  const from = lane && paramDef(lane.param), to = paramDef(param);
  if (!lane || !from || !to || a.lanes.some((l) => l !== lane && l.track === lane.track && l.param === param)) return;
  for (const pt of lane.points) pt.v = Math.round(to.min + ((pt.v - from.min) / (from.max - from.min)) * (to.max - to.min));
  lane.param = param;
}

/** Set the curve's value at a step, replacing a point already there. */
export function setPoint(lane: AutoLane, t: number, v: number): void {
  const def = paramDef(lane.param);
  if (!def) return;
  t = clamp(Math.round(t), 0, MAX_SONG_STEPS);
  v = clamp(Math.round(v), def.min, def.max);
  const pts = lane.points;
  let i = 0;
  while (i < pts.length && pts[i].t < t) i++;
  if (pts[i]?.t === t) pts[i].v = v;
  else if (pts.length < MAX_POINTS) pts.splice(i, 0, { t, v });
}

/** Remove every point strictly between two steps (used while drawing over an old curve). */
export function clearPoints(lane: AutoLane, from: number, to: number): void {
  if (from > to) [from, to] = [to, from];
  lane.points = lane.points.filter((pt) => pt.t <= from || pt.t >= to);
}

// --- tempo, time signature, markers, loop ---

export function addMarker(at: number, name = ''): void {
  const a = arr();
  if (a.markers.length >= MAX_EVENTS) return;
  a.markers = a.markers.filter((m) => m.at !== at);
  const names = ['intro', 'verse', 'hook', 'bridge', 'outro'];
  a.markers.push({ at, name: name || names[a.markers.length % names.length], color: a.markers.length % 8 });
  a.markers.sort((x, y) => x.at - y.at);
}

export function addTempo(at: number): void {
  const a = arr();
  if (at <= 0 || a.tempo.length >= MAX_EVENTS) return;
  const bpm = tempoAt(app.project, at);
  a.tempo = a.tempo.filter((e) => e.at !== at);
  a.tempo.push({ at, bpm });
  a.tempo.sort((x, y) => x.at - y.at);
}

/** A time signature always starts on a bar line. */
export function addSig(at: number): void {
  const a = arr();
  if (a.sigs.length >= MAX_EVENTS) return;
  const b = barAt(app.project, at);
  a.sigs = a.sigs.filter((e) => e.at !== b.start);
  a.sigs.push({ at: b.start, num: b.num === 4 && b.den === 4 ? 3 : 4, den: 4 });
  a.sigs.sort((x, y) => x.at - y.at);
}

/** Keep an event list sorted and free of duplicates after one of its items moved. */
export function settle<T extends { at: number }>(list: T[], moved: T): T[] {
  return list.filter((e) => e === moved || e.at !== moved.at).sort((x, y) => x.at - y.at);
}

export function setLoop(start: number, end: number): void {
  const a = arr();
  if (start > end) [start, end] = [end, start];
  a.loopStart = clamp(start, 0, MAX_SONG_STEPS);
  a.loopEnd = clamp(end, 0, MAX_SONG_STEPS);
  a.loopOn = a.loopEnd > a.loopStart;
}

/** Steps the timeline should show: the song plus some room to grow. */
export function timelineLength(): number {
  const p = app.project, a = p.arr;
  let end = Math.max(songEnd(a), a.loopEnd, app.cursor);
  for (const m of a.markers) end = Math.max(end, m.at);
  for (const e of a.tempo) end = Math.max(end, e.at);
  for (const e of a.sigs) end = Math.max(end, e.at);
  for (const l of a.lanes) if (l.points.length) end = Math.max(end, l.points[l.points.length - 1].t);
  const bars = barsUpTo(p, end);
  const last = bars[bars.length - 1];
  return Math.min(MAX_SONG_STEPS, Math.max(16 * 16, last.start + last.len * 9));
}
