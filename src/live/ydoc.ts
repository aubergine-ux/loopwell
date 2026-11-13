// The beat as a Yjs document, for live sessions. Everything is stored at the
// grain people edit at, so two people changing different things never clash:
// each knob is its own entry, each step and each note is its own entry, and a
// track carries its own patterns, clips and automation, so adding or removing
// a track can't scramble anyone else's work on another track.
//
//   p (map)
//     name, bpm, swing, steps, scaleRoot, scaleType, scaleLock, master
//     fx (map of knobs)      loop (map: on, start, end)
//     tempo, sigs, markers   (small lists, replaced whole)
//     mlanes (map: param -> {on, pts})            master automation
//     tracks (array of maps)
//       id, name, kind, colour, sample, knobs...  synth (map of knobs)
//       slices, fx                                (replaced whole)
//       pats (array of 8 maps): steps (map: step -> velocity), notes (map: "step:pitch" -> {l, v})
//       clips (map: id -> {pattern, start, len, offset})
//       lanes (map: param -> {on, pts})
//
// Which view someone is looking at (pattern or song) is theirs alone and is
// not part of the document.

import * as Y from 'yjs';
import { MAX_STEPS, MAX_TRACKS, NUM_PATTERNS, type AutoLane, type Clip, type Note, type Project, type Track } from '../core/types';

const SETTINGS = ['name', 'bpm', 'swing', 'groove', 'grooveAmt', 'steps', 'scaleRoot', 'scaleType', 'scaleLock', 'master'] as const;
const TRACK_KNOBS = ['name', 'kind', 'color', 'sample', 'tune', 'decay', 'reverse', 'stretch', 'note', 'vol', 'pan', 'mute', 'solo', 'filter', 'rev', 'dly',
  'groove', 'grooveAmt', 'arpMode', 'arpRate', 'arpOct', 'arpGate', 'bus'] as const;

type Json = Record<string, unknown>;
/** Deep equality that doesn't care what order an object's keys are in. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], y[i])) return false;
    return true;
  }
  const x = a as Json, y = b as Json;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) if (!(k in y) || !same(x[k], y[k])) return false;
  return true;
}

/** Make a shared map hold exactly `want`, touching only the entries that differ. */
function syncMap(map: Y.Map<unknown>, want: Json): void {
  for (const k of [...map.keys()]) if (!(k in want)) map.delete(k);
  for (const k in want) if (!same(map.get(k), want[k])) map.set(k, want[k]);
}

function child<T>(map: Y.Map<unknown>, key: string, make: () => T): T {
  let c = map.get(key) as T | undefined;
  if (!c) { c = make(); map.set(key, c); }
  return c;
}

const laneValue = (l: AutoLane) => ({ on: l.on, pts: l.points.map((pt) => [pt.t, pt.v]) });

function writeTrack(yt: Y.Map<unknown>, p: Project, t: Track, ti: number): void {
  const knobs: Json = {};
  for (const k of TRACK_KNOBS) knobs[k] = t[k];
  for (const k in knobs) if (yt.get(k) !== knobs[k]) yt.set(k, knobs[k]);
  if (!same(yt.get('slices'), t.slices)) yt.set('slices', [...t.slices]);
  if (!same(yt.get('fx'), t.fx)) yt.set('fx', JSON.parse(JSON.stringify(t.fx)));
  syncMap(child(yt, 'synth', () => new Y.Map()), t.synth as unknown as Json);
  if (yt.has('bass') || t.kind === 'bass') syncMap(child(yt, 'bass', () => new Y.Map()), t.bass as unknown as Json);
  if (yt.has('dsyn') || t.kind === 'dsyn') syncMap(child(yt, 'dsyn', () => new Y.Map()), t.dsyn as unknown as Json);

  const pats = child(yt, 'pats', () => new Y.Array<Y.Map<unknown>>());
  while (pats.length < NUM_PATTERNS) pats.push([new Y.Map()]);
  for (let pi = 0; pi < NUM_PATTERNS; pi++) {
    const yp = pats.get(pi) as Y.Map<unknown>;
    const steps: Json = {}, notes: Json = {}, mods: Json = {};
    p.patterns[pi].steps[ti].forEach((v, s) => { if (v) steps[s] = v; });
    p.patterns[pi].mods[ti].forEach((v, s) => { if (v) mods[s] = v; });
    for (const n of p.patterns[pi].notes[ti]) notes[`${n.s}:${n.p}`] = { l: n.l, v: n.v };
    syncMap(child(yp, 'steps', () => new Y.Map()), steps);
    syncMap(child(yp, 'notes', () => new Y.Map()), notes);
    // only made once someone uses step extras, so sessions with an older client in them stay untouched
    if (yp.has('mods') || Object.keys(mods).length) syncMap(child(yp, 'mods', () => new Y.Map()), mods);
  }

  const clips: Json = {}, lanes: Json = {};
  for (const c of p.arr.clips) if (c.track === ti) clips[c.id] = { pattern: c.pattern, start: c.start, len: c.len, offset: c.offset };
  for (const l of p.arr.lanes) if (l.track === ti) lanes[l.param] = laneValue(l);
  syncMap(child(yt, 'clips', () => new Y.Map()), clips);
  syncMap(child(yt, 'lanes', () => new Y.Map()), lanes);
}

/**
 * Bring the document in line with a project. `trackIds` names the tracks in
 * order; a track is the same track for everyone as long as it keeps its id.
 * Only what differs is written, so calling this with nothing changed is free.
 */
export function toY(doc: Y.Doc, p: Project, trackIds: string[], origin: unknown = 'local'): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>('p');
    for (const k of SETTINGS) if (root.get(k) !== p[k]) root.set(k, p[k]);
    syncMap(child(root, 'fx', () => new Y.Map()), p.fx as unknown as Json);
    if (root.has('mastering') || p.mastering.on) syncMap(child(root, 'mastering', () => new Y.Map()), p.mastering as unknown as Json);
    const a = p.arr;
    syncMap(child(root, 'loop', () => new Y.Map()), { on: a.loopOn, start: a.loopStart, end: a.loopEnd });
    for (const k of ['tempo', 'sigs', 'markers'] as const) if (!same(root.get(k), a[k])) root.set(k, JSON.parse(JSON.stringify(a[k])));
    // groups are few and small, so the list is replaced whole; left out until a beat has one
    if ((root.has('buses') || p.buses.length) && !same(root.get('buses'), p.buses)) root.set('buses', JSON.parse(JSON.stringify(p.buses)));
    if ((root.has('lyrics') || p.lyrics.length) && !same(root.get('lyrics'), p.lyrics)) root.set('lyrics', JSON.parse(JSON.stringify(p.lyrics)));
    const mlanes: Json = {};
    for (const l of a.lanes) if (l.track < 0) mlanes[l.param] = laneValue(l);
    syncMap(child(root, 'mlanes', () => new Y.Map()), mlanes);

    const tracks = child(root, 'tracks', () => new Y.Array<Y.Map<unknown>>());
    const idAt = (i: number) => (tracks.get(i) as Y.Map<unknown> | undefined)?.get('id');
    for (let i = tracks.length - 1; i >= 0; i--) if (!trackIds.includes(idAt(i) as string)) tracks.delete(i, 1);
    for (let i = 0; i < trackIds.length; i++) {
      if (idAt(i) === trackIds[i]) continue;
      const yt = new Y.Map<unknown>();
      yt.set('id', trackIds[i]);
      tracks.insert(i, [yt]);
    }
    for (let i = 0; i < trackIds.length; i++) writeTrack(tracks.get(i) as Y.Map<unknown>, p, p.tracks[i], i);
  }, origin);
}

/** Read the document back as plain project data (run it through `sanitize`), plus the ids of its tracks. */
export function fromY(doc: Y.Doc): { project: Json; trackIds: string[] } | null {
  const root = doc.getMap<unknown>('p');
  const ytracks = root.get('tracks');
  if (!(ytracks instanceof Y.Array) || !ytracks.length) return null;
  const project: Json = { v: 2 };
  for (const k of SETTINGS) project[k] = root.get(k);
  project.fx = (root.get('fx') as Y.Map<unknown> | undefined)?.toJSON() ?? {};
  project.buses = root.get('buses') ?? [];
  project.lyrics = root.get('lyrics') ?? [];
  project.mastering = (root.get('mastering') as Y.Map<unknown> | undefined)?.toJSON();
  const loop = ((root.get('loop') as Y.Map<unknown> | undefined)?.toJSON() ?? {}) as Json;
  const clips: Partial<Clip>[] = [], lanes: Json[] = [];
  const points = (v: any) => (Array.isArray(v?.pts) ? v.pts.map((pt: number[]) => ({ t: pt[0], v: pt[1] })) : []);

  const trackIds: string[] = [];
  const tracks: Json[] = [];
  const patterns = Array.from({ length: NUM_PATTERNS }, () => ({ steps: [] as number[][], notes: [] as Note[][], mods: [] as number[][] }));
  // two people adding a track at the same moment can overshoot the limit; everyone drops the same extras
  ytracks.toArray().slice(0, MAX_TRACKS).forEach((yt, ti) => {
    if (!(yt instanceof Y.Map)) return;
    const id = String(yt.get('id'));
    trackIds.push(id);
    const t: Json = {};
    for (const k of TRACK_KNOBS) t[k] = yt.get(k);
    t.slices = yt.get('slices');
    t.fx = yt.get('fx');
    t.synth = (yt.get('synth') as Y.Map<unknown> | undefined)?.toJSON() ?? {};
    t.bass = (yt.get('bass') as Y.Map<unknown> | undefined)?.toJSON();
    t.dsyn = (yt.get('dsyn') as Y.Map<unknown> | undefined)?.toJSON();
    tracks.push(t);
    const pats = yt.get('pats') as Y.Array<Y.Map<unknown>> | undefined;
    for (let pi = 0; pi < NUM_PATTERNS; pi++) {
      const yp = pats?.get(pi);
      const steps = new Array<number>(MAX_STEPS).fill(0);
      const notes: Note[] = [];
      const mods = new Array<number>(MAX_STEPS).fill(0);
      (yp?.get('mods') as Y.Map<number> | undefined)?.forEach((v, s) => { if (+s < MAX_STEPS) mods[+s] = v; });
      (yp?.get('steps') as Y.Map<number> | undefined)?.forEach((v, s) => { if (+s < MAX_STEPS) steps[+s] = v; });
      (yp?.get('notes') as Y.Map<{ l: number; v: number }> | undefined)?.forEach((n, key) => {
        const [s, pitch] = key.split(':').map(Number);
        notes.push({ s, p: pitch, l: n.l, v: n.v });
      });
      notes.sort((x, y) => x.s - y.s || x.p - y.p);
      patterns[pi].steps.push(steps);
      patterns[pi].mods.push(mods);
      patterns[pi].notes.push(notes);
    }
    (yt.get('clips') as Y.Map<Json> | undefined)?.forEach((c, cid) => clips.push({ ...c, id: cid, track: ti }));
    (yt.get('lanes') as Y.Map<Json> | undefined)?.forEach((l, param) => lanes.push({ id: `${id}.${param}`.slice(0, 16), track: ti, param, on: l.on, points: points(l) }));
  });
  (root.get('mlanes') as Y.Map<Json> | undefined)?.forEach((l, param) => lanes.push({ id: `m.${param}`, track: -1, param, on: l.on, points: points(l) }));
  clips.sort((x, y) => x.start! - y.start! || x.track! - y.track! || (x.id! < y.id! ? -1 : 1));
  lanes.sort((x, y) => (x.track as number) - (y.track as number) || ((x.param as string) < (y.param as string) ? -1 : 1));

  project.tracks = tracks;
  project.patterns = patterns;
  project.arr = {
    clips, lanes, tempo: root.get('tempo') ?? [], sigs: root.get('sigs') ?? [], markers: root.get('markers') ?? [],
    loopOn: loop.on, loopStart: loop.start, loopEnd: loop.end,
  };
  return { project, trackIds };
}

/**
 * Make `target` equal to `source` by changing only what differs. The app's
 * state is patched this way when someone else's edit arrives, so the interface
 * redraws just the knob or step that moved.
 */
export function patchInto(target: any, source: any): void {
  if (Array.isArray(source)) {
    if (target.length > source.length) target.length = source.length;
    for (let i = 0; i < source.length; i++) {
      const s = source[i], t = target[i];
      if (s !== null && typeof s === 'object' && t !== null && typeof t === 'object' && Array.isArray(s) === Array.isArray(t)) patchInto(t, s);
      else if (t !== s) target[i] = s;
    }
    return;
  }
  for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
  for (const k of Object.keys(source)) {
    const s = source[k], t = target[k];
    if (s !== null && typeof s === 'object' && t !== null && typeof t === 'object' && Array.isArray(s) === Array.isArray(t)) patchInto(t, s);
    else if (t !== s) target[k] = s;
  }
}

/** A few words on what changed between two versions of a beat, for the activity log. Empty if nothing did. */
export function describeChange(before: Project, after: Project): string {
  const out: string[] = [];
  const say = (s: string) => { if (!out.includes(s)) out.push(s); };
  if (before.bpm !== after.bpm) say(`tempo ${before.bpm} → ${after.bpm}`);
  if (before.swing !== after.swing) say('swing');
  if (before.groove !== after.groove || before.grooveAmt !== after.grooveAmt) say('the groove');
  if (before.name !== after.name) say(`renamed the beat “${after.name}”`);
  if (before.steps !== after.steps) say(`${after.steps} steps`);
  if (before.master !== after.master) say('master volume');
  if (before.scaleRoot !== after.scaleRoot || before.scaleType !== after.scaleType || before.scaleLock !== after.scaleLock) say('the key');
  if (!same(before.fx, after.fx)) say('master effects');
  if (!same(before.buses, after.buses)) say('groups');
  if (!same(before.lyrics, after.lyrics)) say('lyrics');
  if (!same(before.mastering, after.mastering)) say('mastering');
  if (after.tracks.length > before.tracks.length) say(`added ${after.tracks[after.tracks.length - 1].name}`);
  if (after.tracks.length < before.tracks.length) say('removed a track');
  const n = Math.min(before.tracks.length, after.tracks.length);
  for (let t = 0; t < n && after.tracks.length === before.tracks.length; t++) {
    const a = before.tracks[t], b = after.tracks[t], name = b.name;
    if (a.sample !== b.sample || a.kind !== b.kind || !same(a.synth, b.synth) || !same(a.bass, b.bass) || !same(a.dsyn, b.dsyn) || !same(a.slices, b.slices) || a.reverse !== b.reverse || a.stretch !== b.stretch
      || a.tune !== b.tune || a.decay !== b.decay) say(`${name}: sound`);
    if (!same(a.fx, b.fx)) say(`${name}: effects`);
    if (a.mute !== b.mute) say(`${b.mute ? 'muted' : 'unmuted'} ${name}`);
    if (a.solo !== b.solo) say(`${b.solo ? 'soloed' : 'unsoloed'} ${name}`);
    if (a.groove !== b.groove || a.grooveAmt !== b.grooveAmt) say(`${name}: groove`);
    if (a.arpMode !== b.arpMode || a.arpRate !== b.arpRate || a.arpOct !== b.arpOct || a.arpGate !== b.arpGate) say(`${name}: arpeggiator`);
    if (a.bus !== b.bus) say(`${name}: routing`);
    if (a.vol !== b.vol || a.pan !== b.pan || a.filter !== b.filter || a.rev !== b.rev || a.dly !== b.dly) say(`${name}: mix`);
    if (a.name !== b.name) say(`renamed ${a.name} to ${name}`);
    for (let pi = 0; pi < NUM_PATTERNS; pi++) {
      if (!same(before.patterns[pi].steps[t], after.patterns[pi].steps[t]) || !same(before.patterns[pi].notes[t], after.patterns[pi].notes[t])
        || !same(before.patterns[pi].mods[t], after.patterns[pi].mods[t])) {
        say(`${name}: pattern ${'ABCDEFGH'[pi]}`);
      }
    }
  }
  const clips = (p: Project) => p.arr.clips.map((c) => `${c.track},${c.start},${c.len},${c.pattern},${c.offset}`).sort();
  const lanes = (p: Project) => p.arr.lanes.map((l) => JSON.stringify([l.track, l.param, l.on, l.points])).sort();
  if (!same(clips(before), clips(after))) say('the arrangement');
  if (!same(lanes(before), lanes(after))) say('automation');
  if (!same(before.arr.tempo, after.arr.tempo) || !same(before.arr.sigs, after.arr.sigs)) say('tempo map');
  if (!same(before.arr.markers, after.arr.markers)) say('markers');
  return out.slice(0, 3).join(', ') + (out.length > 3 ? ` and ${out.length - 3} more` : '');
}
