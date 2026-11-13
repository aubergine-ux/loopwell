// MIDI learn. Click a control on screen, move one on the controller, and the
// two are tied together. A mapping points at a place in the beat (a knob of a
// track, a master effect) or at one of the live controls; mappings are kept in
// this browser, and whole sets can be saved by name, one per controller.

import { toast } from './actions.svelte';
import { fxMove, fxToggle, stage } from './perform.svelte';
import { app } from './state.svelte';

const KEY = 'loopwell:midimap';
const MAX_MAPS = 128;

/** Live controls that aren't part of the beat. */
const SPECIAL = ['perf.x', 'perf.y', 'perf.on'] as const;
type Special = (typeof SPECIAL)[number];

export interface Mapping {
  /** What the controller sends: "cc:<channel>:<number>" or "note:<channel>:<number>". */
  from: string;
  /** Where it goes: a path into the project as JSON, or one of the live controls. */
  to: string;
  label: string;
  min: number;
  max: number;
  /** For a track's knob: move that knob on whichever track is selected, rather than always the same track. */
  follow: boolean;
  device: string;
}

interface Target {
  to: string;
  label: string;
  min: number;
  max: number;
}

function clean(list: unknown): Mapping[] {
  if (!Array.isArray(list)) return [];
  const out: Mapping[] = [];
  for (const m of list.slice(0, MAX_MAPS)) {
    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string' || !/^(cc|note):\d+:\d+$/.test(m.from)) continue;
    const min = Number(m.min), max = Number(m.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) continue;
    out.push({ from: m.from, to: m.to, label: String(m.label ?? '').slice(0, 40), min, max, follow: !!m.follow, device: String(m.device ?? '').slice(0, 60) });
  }
  return out;
}

function load(): { maps: Mapping[]; saved: Record<string, Mapping[]> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const saved: Record<string, Mapping[]> = {};
    if (raw.saved && typeof raw.saved === 'object') for (const name of Object.keys(raw.saved).slice(0, 24)) saved[name.slice(0, 30)] = clean(raw.saved[name]);
    return { maps: clean(raw.maps), saved };
  } catch {
    return { maps: [], saved: {} };
  }
}

const stored = load();
export const midimap = $state({
  learning: false,
  /** The control picked on screen, waiting for the controller to be moved. */
  target: null as Target | null,
  maps: stored.maps,
  saved: stored.saved,
});

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify({ maps: midimap.maps, saved: midimap.saved })); } catch { /* private mode or full */ }
}

export const isLearning = () => midimap.learning;

export function setLearning(on: boolean): void {
  midimap.learning = on;
  midimap.target = null;
  if (on) document.documentElement.dataset.learn = '';
  else delete document.documentElement.dataset.learn;
}

/** Where two versions of the beat differ, as a path of keys. */
function diffPath(a: any, b: any, path: (string | number)[] = []): (string | number)[] | null {
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return path;
  for (const k of Object.keys(a)) {
    const found = diffPath(a[k], b[k], [...path, Array.isArray(a) ? +k : k]);
    if (found) return found;
  }
  return null;
}

/**
 * A knob or fader was clicked while learning. Which part of the beat it moves isn't something the knob
 * knows, so nudge it, see what changed, and put it back.
 */
export function learnKnob(label: string, min: number, max: number, value: number, set: (v: number) => void): void {
  const before = $state.snapshot(app.project);
  set(value === max ? min : max);
  const path = diffPath(before, $state.snapshot(app.project));
  set(value);
  if (!path) {
    toast(`“${label}” isn't part of the beat, so it can't be tied to a controller.`);
    return;
  }
  const track = path[0] === 'tracks' ? app.project.tracks[path[1] as number]?.name : '';
  midimap.target = { to: JSON.stringify(path), label: track ? `${track} · ${label}` : label, min, max };
}

/** One of the live controls was clicked while learning. */
export function learnClick(to: Special, label: string): void {
  midimap.target = { to, label, min: 0, max: 1 };
}

function describe(from: string): string {
  const [kind, ch, num] = from.split(':');
  return `${kind === 'cc' ? 'CC' : 'Note'} ${num} (ch ${+ch + 1})`;
}
export const sourceLabel = describe;

function bind(from: string, device: string): void {
  const t = midimap.target;
  if (!t) return;
  // a button (note) can only switch things on and off
  if (from.startsWith('note:') && t.to !== 'perf.on') { toast('Keys and pads can only be tied to on/off controls. Move a knob or fader instead.'); return; }
  const rest = midimap.maps.filter((m) => m.from !== from && m.to !== t.to);
  if (rest.length >= MAX_MAPS) { toast('That is as many mappings as Loopwell keeps.', 'error'); return; }
  midimap.maps = [...rest, { from, ...t, follow: false, device }];
  midimap.target = null;
  save();
  toast(`${describe(from)} now moves ${t.label}`);
}

function apply(m: Mapping, v: number): void {
  if (m.to === 'perf.x') { fxMove(v / 127, stage.y, stage.fxOn); return; }
  if (m.to === 'perf.y') { fxMove(stage.x, v / 127, stage.fxOn); return; }
  if (m.to === 'perf.on') { fxToggle(v >= 64); return; }
  let path: (string | number)[];
  try { path = JSON.parse(m.to); } catch { return; }
  if (m.follow && path[0] === 'tracks') path[1] = app.sel;
  let o: any = app.project;
  for (let i = 0; i < path.length - 1 && o; i++) o = o[path[i]];
  const key = path[path.length - 1];
  // the beat may have changed shape since this was learned (a track removed, another kind of track)
  if (!o || typeof o[key] !== 'number') return;
  const next = Math.round(m.min + (v / 127) * (m.max - m.min));
  if (o[key] !== next) o[key] = next;
}

/** A control change or note arrived. Returns true if a mapping (or learning) took it. */
export function midiControl(kind: 'cc' | 'note', channel: number, number: number, value: number, device: string): boolean {
  const from = `${kind}:${channel}:${number}`;
  if (midimap.learning && midimap.target) {
    if (kind === 'cc' || value > 0) bind(from, device);
    return true;
  }
  const m = midimap.maps.find((x) => x.from === from);
  if (!m) return false;
  apply(m, value);
  return true;
}

export function removeMapping(from: string): void {
  midimap.maps = midimap.maps.filter((m) => m.from !== from);
  save();
}

export function setFollow(from: string, follow: boolean): void {
  const m = midimap.maps.find((x) => x.from === from);
  if (m) { m.follow = follow; save(); }
}

export const canFollow = (m: Mapping) => m.to.startsWith('["tracks"');

export function clearMappings(): void {
  midimap.maps = [];
  save();
}

/** Keep the current mappings under a name, so they can be brought back for that controller. */
export function saveSet(name: string): boolean {
  const n = name.trim().slice(0, 30);
  if (!n || !midimap.maps.length) return false;
  midimap.saved[n] = $state.snapshot(midimap.maps) as Mapping[];
  save();
  return true;
}

export function loadSet(name: string): void {
  const set = midimap.saved[name];
  if (!set) return;
  midimap.maps = clean($state.snapshot(set));
  save();
}

export function deleteSet(name: string): void {
  delete midimap.saved[name];
  save();
}
