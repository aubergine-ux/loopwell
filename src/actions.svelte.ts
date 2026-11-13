// Everything the interface can do to the beat. Components call these rather
// than poking the engine themselves.

import { zipSync } from 'fflate';
import { audio } from './audio/host';
import { KITS, isBuiltin, isUser, slotLabel } from './core/kits';
import { exportMidi } from './core/midi';
import { describeChange } from './live/ydoc';
import { packProjectFile, unpackProjectFile, type UserSample } from './core/projectfile';
import { renderProject } from './core/render';
import { beatFromHash, beatUrl, HASH_KEY } from './core/share';
import { isDefaultArrangement, tempoAt, trackStepAt } from './core/arrange';
import {
  DEFAULT_VEL, MAX_STEPS, MAX_TRACKS, clamp, emptyArrangement, emptyProject, newId, newTrack, sanitize, usesNotes, usesSample,
  type Project, type TrackKind,
} from './core/types';
import { CODECS, encodeAudio, type Codec } from './core/encode';
import { normalize, type LoudnessTarget } from './core/loudness';
import { encodeWav } from './core/wav';
import { applyPrefs, prefs } from './prefs.svelte';
import { app, THEMES } from './state.svelte';
import { deleteSample, getSamples, loadSaved, loadTheme, putSample, saveProject, saveTheme } from './storage';
import { flash, startVisuals } from './visual';
import { isDesktop, log, onProjectOpened, saveFile } from './desktop';
import { initCommunity } from './community/store.svelte';

// --- small helpers ---------------------------------------------------------

let toastId = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const id = ++toastId;
  app.toast = { msg, kind, id };
  setTimeout(() => { if (app.toast?.id === id) app.toast = null; }, kind === 'error' ? 5200 : 2600);
}

const snapshot = (): Project => $state.snapshot(app.project) as Project;
const slug = () => (app.project.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'loopwell-beat');
const nextPaint = () => new Promise<void>((r) => setTimeout(r));

function download(data: Uint8Array<ArrayBuffer>, name: string, type: string): void {
  // the desktop app has no downloads folder to drop things in: it asks where to save
  if (isDesktop) {
    void saveFile(name, data).catch((e) => toast(String(e), 'error'));
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- history & persistence -------------------------------------------------
// Every state the beat has been in, oldest first, with a few words on what
// changed to get there. Undo and redo walk along it; the history panel jumps.

interface Past { json: string; label: string; time: number }
const MAX_HISTORY = 100;
const states: Past[] = [];
let at = -1;
let commitTimer = 0;

/** Called with the beat (as JSON) each time a change is committed, for anything that keeps a copy of it. */
export const saveHooks: ((json: string) => void)[] = [];

function mirror(): void {
  app.history = states.map((s) => ({ label: s.label, time: s.time }));
  app.historyAt = at;
  app.canUndo = at > 0;
  app.canRedo = at < states.length - 1;
}

function commit(label?: string): void {
  clearTimeout(commitTimer);
  const cur = JSON.stringify(app.project);
  const prev = states[at];
  if (prev && cur === prev.json) return;
  states.length = at + 1; // a new change drops whatever had been undone
  let said = label;
  if (!said && prev) {
    try { said = describeChange(JSON.parse(prev.json), JSON.parse(cur)); } catch { /* a state that can't be compared still gets recorded */ }
  }
  states.push({ json: cur, label: said || 'Edit', time: Date.now() });
  if (states.length > MAX_HISTORY) states.shift();
  at = states.length - 1;
  saveProject(cur);
  for (const hook of saveHooks) hook(cur);
  mirror();
}

/** Close the current undo step now, so that the next edit is undone on its own. */
export function checkpoint(): void {
  commit();
}

/**
 * Places where a live session plugs in. They stay empty when playing alone.
 * `changed` sees every edit (and may veto it by returning false, after putting the project back);
 * `transport` may take over play and stop; `tracks` hears about tracks being added and removed.
 */
export const hooks = {
  changed: null as null | ((snap: Project) => boolean),
  transport: null as null | ((playing: boolean) => boolean),
  tracks: null as null | ((added: boolean, index: number) => void),
  /** Undo would roll back other people's edits too, so a session switches it off. */
  noHistory: false,
};

/** Called (via an effect) whenever anything in the project changes. */
export function projectChanged(snap: Project): void {
  if (hooks.changed && !hooks.changed(snap)) return;
  audio.setProject(snap);
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commit, 350);
}

function restore(i: number): void {
  at = i;
  const json = states[i].json;
  app.project = JSON.parse(json);
  saveProject(json);
  for (const hook of saveHooks) hook(json);
  fixSelection();
  mirror();
}

export function undo(): void {
  if (hooks.noHistory) { toast('Undo is off during a live session, so nobody loses someone else\'s changes.'); return; }
  commit();
  if (at > 0) restore(at - 1);
}

export function redo(): void {
  if (hooks.noHistory) return;
  commit();
  if (at < states.length - 1) restore(at + 1);
}

/** Go straight to any point in the history (the history panel). */
export function jumpTo(i: number): void {
  if (hooks.noHistory) { toast('History is off during a live session, so nobody loses someone else\'s changes.'); return; }
  commit();
  if (i >= 0 && i < states.length && i !== at) restore(i);
}

export function fixSelection(): void {
  app.sel = clamp(app.sel, 0, app.project.tracks.length - 1);
  app.pat = clamp(app.pat, 0, app.project.patterns.length - 1);
  if (app.clip && !app.project.arr.clips.some((c) => c.id === app.clip)) app.clip = null;
  if (app.step && (app.step.t >= app.project.tracks.length || app.step.s >= app.project.steps)) app.step = null;
  if (app.rackBus >= app.project.buses.length) app.rackBus = -1;
}

/** Called when playback starts (true) and stops (false), for things that run alongside the transport. */
export const transportHooks: ((playing: boolean) => void)[] = [];

/** Called once a different beat is in place, to put anything that plays live back to how a beat normally starts. */
export const resetHooks: (() => void)[] = [];

/** Called whenever a different beat is loaded, so things tied to the old one can let go. */
export const loadHooks: (() => void)[] = [];

/** Replace the whole beat. The old one stays reachable with undo. */
export function loadProject(p: Project, label = `Opened “${p.name}”`): void {
  for (const hook of loadHooks) hook();
  commit();
  stopPlaying();
  app.project = p;
  app.pat = 0;
  app.sel = 0;
  app.cursor = 0;
  app.clip = null;
  app.step = null;
  app.range = null;
  app.locks = [];
  for (const hook of resetHooks) hook();
  fixSelection();
  commit(label);
}

export function newBeat(): void {
  loadProject(starter());
  toast('Fresh beat. Undo brings the old one back.');
}

/** What a first-time visitor sees: just enough that pressing play makes a sound. */
function starter(): Project {
  const p = emptyProject();
  [0, 4, 8, 12].forEach((s) => (p.patterns[0].steps[0][s] = DEFAULT_VEL));
  [4, 12].forEach((s) => (p.patterns[0].steps[2][s] = DEFAULT_VEL));
  [2, 6, 10, 14].forEach((s) => (p.patterns[0].steps[3][s] = DEFAULT_VEL));
  return p;
}

export function setTheme(id: string): void {
  app.theme = THEMES.some((t) => t.id === id) ? id : THEMES[0].id;
  document.documentElement.dataset.theme = app.theme;
  saveTheme(app.theme);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

export function cycleTheme(): void {
  const i = THEMES.findIndex((t) => t.id === app.theme);
  setTheme(THEMES[(i + 1) % THEMES.length].id);
}

// --- transport -------------------------------------------------------------

export async function play(): Promise<void> {
  if (!(await audio.resume())) {
    toast('Your browser is blocking sound. Tap or click once, then press play.');
    return;
  }
  app.needsTap = false;
  if (hooks.transport?.(true)) return; // in a session everyone starts together
  // a count-in gives you time to get your hands in place before a recording
  startPlaying(app.pat, app.cursor, 0, app.rec ? prefs.countIn * 16 : 0);
}

/** Start the engine now. `step` starts a looping pattern part-way through (joining a session that is already playing). */
export function startPlaying(pattern: number, from: number, step = 0, countIn = 0): void {
  audio.play(pattern, from, step, countIn);
  app.playing = true;
  for (const hook of transportHooks) hook(true);
}

export function stop(): void {
  if (hooks.transport?.(false)) return;
  stopPlaying();
}

export function stopPlaying(): void {
  audio.stop();
  app.playing = false;
  app.queued = -1;
  for (const hook of transportHooks) hook(false);
}

export function togglePlay(): void {
  if (app.playing) stop();
  else void play();
}

export function selectPattern(i: number): void {
  // the song decides what plays; picking a pattern there only changes what you are editing
  if (!app.playing || app.project.songMode) {
    app.pat = i;
    audio.setPattern(i);
    return;
  }
  // a looping pattern hands over on the bar line
  app.queued = i === app.pat ? -1 : i;
  audio.setPattern(i);
}

/** Pattern view loops one pattern; song view plays the timeline. Playback carries on across the switch. */
export function setView(song: boolean): void {
  if (app.project.songMode === song) return;
  if (!song) audio.setPattern(app.pat);
  app.project.songMode = song;
  app.queued = -1;
}

export function setSteps(n: 16 | 32): void {
  const p = app.project;
  if (p.steps === n) return;
  const untouched = isDefaultArrangement(p);
  p.steps = n;
  if (untouched) p.arr = emptyArrangement(p.tracks.length, n);
  for (const c of p.arr.clips) c.offset %= n;
  app.range = null;
  fixSelection();
}

const taps: number[] = [];
export function tapTempo(): void {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length >= 3) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    app.project.bpm = clamp(Math.round(60000 / avg), 40, 240);
  }
}

// --- editing ---------------------------------------------------------------

/** Velocity shown for a cell in the step grid (0 = off). */
export function stepVel(t: number, s: number, pat = app.pat): number {
  const p = app.project.patterns[pat];
  if (!usesNotes(app.project.tracks[t].kind)) return p.steps[t][s];
  let v = 0;
  for (const n of p.notes[t]) if (n.s === s && n.v > v) v = n.v;
  return v;
}

export function setStep(t: number, s: number, vel: number, pat = app.pat): void {
  const tr = app.project.tracks[t];
  const p = app.project.patterns[pat];
  if (!vel) p.mods[t][s] = 0; // a step that is switched off forgets its extras
  if (!usesNotes(tr.kind)) {
    p.steps[t][s] = vel;
  } else if (vel === 0) {
    p.notes[t] = p.notes[t].filter((n) => n.s !== s);
  } else {
    const here = p.notes[t].filter((n) => n.s === s);
    if (here.length) here.forEach((n) => (n.v = vel));
    else p.notes[t].push({ s, l: 1, p: tr.note, v: vel });
  }
}

export function addTrack(kind: TrackKind): void {
  const p = app.project;
  if (p.tracks.length >= MAX_TRACKS) return;
  const used = new Set(p.tracks.map((t) => t.color));
  let color = 0;
  while (used.has(color) && color < 7) color++;
  const kit = p.tracks.find((t) => t.kind === 'drum' && isBuiltin(t.sample))?.sample.split('/')[0] ?? KITS[0].id;
  const untouched = isDefaultArrangement(p);
  const name = { drum: 'RIM', synth: 'SYNTH', slice: 'CHOP', bass: '808', dsyn: 'DRUM' }[kind];
  const tr = newTrack(kind, color, name, `${kit}/rim`);
  tr.bass.key = p.scaleRoot;
  if (kind === 'bass') tr.note = 36 + ((p.scaleRoot + 6) % 12) - 6;
  p.tracks.push(tr);
  for (const pat of p.patterns) {
    pat.steps.push(new Array<number>(MAX_STEPS).fill(0));
    pat.notes.push([]);
    pat.mods.push(new Array<number>(MAX_STEPS).fill(0));
  }
  app.sel = p.tracks.length - 1;
  hooks.tracks?.(true, app.sel);
  // a beat that has never been arranged keeps playing all of its tracks in song view
  if (untouched) p.arr.clips.push({ id: newId(), track: app.sel, pattern: 0, start: 0, len: p.steps, offset: 0 });
}

export function removeTrack(i: number): void {
  const p = app.project;
  if (p.tracks.length <= 1) return;
  p.tracks.splice(i, 1);
  app.locks.splice(i, 1);
  hooks.tracks?.(false, i);
  for (const pat of p.patterns) {
    pat.steps.splice(i, 1);
    pat.mods.splice(i, 1);
    pat.notes.splice(i, 1);
  }
  const a = p.arr;
  a.clips = a.clips.filter((c) => c.track !== i);
  a.lanes = a.lanes.filter((l) => l.track !== i);
  for (const c of a.clips) if (c.track > i) c.track--;
  for (const l of a.lanes) if (l.track > i) l.track--;
  fixSelection();
}

export function clearTrack(t: number, pat = app.pat): void {
  app.project.patterns[pat].steps[t].fill(0);
  app.project.patterns[pat].mods[t].fill(0);
  app.project.patterns[pat].notes[t] = [];
}

export function clearPattern(pat = app.pat): void {
  app.project.tracks.forEach((_, t) => clearTrack(t, pat));
}

export function copyPattern(from: number, to: number): void {
  if (from === to) return;
  app.project.patterns[to] = JSON.parse(JSON.stringify(app.project.patterns[from]));
}

export function assignSample(t: number, id: string): void {
  const tr = app.project.tracks[t];
  tr.sample = id;
  if (isBuiltin(id)) tr.name = slotLabel(id).toUpperCase();
  void audio.ensure(id).then(() => audio.trigger(t, 110));
  flash(t, 110);
}

/** Put any sample from the library on a track, turning the track into one that plays samples if it isn't. */
export function useSample(t: number, id: string): void {
  const tr = app.project.tracks[t];
  if (!tr) return;
  checkpoint();
  if (!usesSample(tr.kind)) tr.kind = 'drum';
  if (tr.sample !== id) tr.slices = tr.kind === 'slice' ? [0] : [];
  if (isBuiltin(id)) { assignSample(t, id); return; }
  tr.sample = id;
  tr.name = (app.userSamples[id] ?? 'sample').replace(/\.[^.]+$/, '').slice(0, 12).toUpperCase() || 'SAMPLE';
  audio.trigger(t, 110);
  flash(t, 110);
}

/** Swap every built-in drum sound for the same slot in another kit. */
export function useKit(kit: string): void {
  for (const tr of app.project.tracks) {
    if (tr.kind !== 'drum' || !isBuiltin(tr.sample)) continue;
    const next = `${kit}/${tr.sample.split('/')[1]}`;
    const renamed = tr.name === slotLabel(tr.sample).toUpperCase();
    tr.sample = next;
    if (renamed) tr.name = slotLabel(next).toUpperCase();
  }
}

// --- playing live ----------------------------------------------------------

const stepSeconds = () => 15 / (app.project.songMode ? tempoAt(app.project, app.cursor) : app.project.bpm);

/** Where a live hit lands: the heard step, mapped through the track's clip when the song is playing. */
function recordTarget(t: number): { step: number; pattern: number; wait: number } | null {
  const n = audio.nearest(stepSeconds());
  if (!n) return null;
  const p = app.project;
  if (n.song < 0) return { step: n.step % p.steps, pattern: n.pattern, wait: n.wait };
  const at = trackStepAt(p, t, n.step);
  return at ? { step: at.local, pattern: at.pattern, wait: n.wait } : null;
}
const heldNotes = new Map<string, { step: number; pattern: number; at: number; wait: number; vel: number }>();

export function padDown(t: number, vel = 110): void {
  const tr = app.project.tracks[t];
  if (!tr) return;
  void audio.resume();
  if (usesNotes(tr.kind)) return noteDown(t, tr.note, vel);
  audio.trigger(t, vel);
  flash(t, vel);
  if (!app.rec || !app.playing) return;
  const n = recordTarget(t);
  if (!n) return;
  // Written once the step has gone by, so the hit you just played isn't doubled by the sequencer.
  setTimeout(() => {
    const row = app.project.patterns[n.pattern]?.steps[t];
    if (row) row[n.step] = vel;
  }, n.wait * 1000 + 40);
}

export function padUp(t: number): void {
  const tr = app.project.tracks[t];
  if (tr && usesNotes(tr.kind)) noteUp(t, tr.note);
}

export function noteDown(t: number, pitch: number, vel = 100): void {
  const tr = app.project.tracks[t];
  if (!tr || !usesNotes(tr.kind)) return;
  void audio.resume();
  pitch = clamp(pitch, 0, 127);
  audio.noteOn(t, pitch, vel);
  flash(t, vel);
  if (app.rec && app.playing) {
    const n = recordTarget(t);
    if (n) heldNotes.set(`${t}:${pitch}`, { step: n.step, pattern: n.pattern, at: performance.now(), wait: n.wait, vel });
  }
}

export function noteUp(t: number, pitch: number): void {
  pitch = clamp(pitch, 0, 127);
  audio.noteOff(t, pitch);
  const key = `${t}:${pitch}`;
  const h = heldNotes.get(key);
  if (!h) return;
  heldNotes.delete(key);
  const held = (performance.now() - h.at) / 1000;
  const len = clamp(Math.round((held - h.wait) / stepSeconds()), 1, MAX_STEPS);
  setTimeout(() => {
    const notes = app.project.patterns[h.pattern]?.notes[t];
    if (!notes) return;
    const at = notes.findIndex((n) => n.s === h.step && n.p === pitch);
    if (at >= 0) notes.splice(at, 1);
    notes.push({ s: h.step, l: len, p: pitch, v: h.vel });
  }, Math.max(0, h.wait - held) * 1000 + 40);
}

/** Preview a note for a moment (piano roll clicks). */
export function auditionNote(t: number, pitch: number, vel = 100): void {
  void audio.resume();
  audio.trigger(t, vel, pitch);
  flash(t, vel);
}

// --- custom samples & files ------------------------------------------------

const userBytes = new Map<string, UserSample>();

export function hashId(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return `user/${(h >>> 0).toString(16).padStart(8, '0')}${(b.length & 0xffff).toString(16)}`;
}

export async function registerSample(s: UserSample, persist: boolean): Promise<boolean> {
  const ok = await audio.addSample(s.id, s.bytes.buffer.slice(s.bytes.byteOffset, s.bytes.byteOffset + s.bytes.byteLength) as ArrayBuffer);
  if (!ok) return false;
  userBytes.set(s.id, s);
  app.userSamples[s.id] = s.name;
  if (persist) void putSample(s);
  return true;
}

const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;

/** Read an audio file into the sample library. Returns its id, or null (after saying why) if it can't be used. */
export async function addToLibrary(file: File): Promise<string | null> {
  if (file.size === 0) { toast(`${file.name} is empty.`, 'error'); return null; }
  if (file.size > MAX_SAMPLE_BYTES) { toast(`${file.name} is too big (25 MB max).`, 'error'); return null; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = hashId(bytes);
  if (!(await registerSample({ id, name: file.name, bytes }, true))) {
    toast(`Couldn't read ${file.name} as audio.`, 'error');
    return null;
  }
  return id;
}

/** Take an imported sample out of the library for good. Tracks still pointing at it fall silent until given another. */
export function forgetSample(id: string): void {
  if (!isUser(id)) return;
  userBytes.delete(id);
  delete app.userSamples[id];
  audio.dropSample(id);
  void deleteSample(id);
}

export async function importSample(file: File, t: number): Promise<boolean> {
  const id = await addToLibrary(file);
  if (!id) return false;
  const tr = app.project.tracks[t];
  if (!tr) return false;
  if (!usesSample(tr.kind)) tr.kind = 'drum';
  tr.slices = [];
  tr.sample = id;
  tr.name = file.name.replace(/\.[^.]+$/, '').slice(0, 12).toUpperCase() || 'SAMPLE';
  audio.trigger(t, 110);
  flash(t, 110);
  return true;
}

/** Files dropped on the app or picked from a dialog: project files open, audio becomes samples. */
export async function handleFiles(files: File[], track = app.sel): Promise<void> {
  let t = track;
  for (const f of files) {
    if (/\.(loopwell|zip)$/i.test(f.name)) {
      await openProjectFile(f);
      return;
    }
    if (t >= app.project.tracks.length) {
      if (app.project.tracks.length >= MAX_TRACKS) { toast('All 8 tracks are in use.', 'error'); return; }
      addTrack('drum');
      t = app.project.tracks.length - 1;
    }
    if (await importSample(f, t)) { app.sel = t; t++; }
  }
}

export function sampleName(id: string): string {
  if (isBuiltin(id)) return slotLabel(id);
  return app.userSamples[id] ?? 'missing sample';
}

/** True when a track points at a custom sample this browser doesn't have. */
export const sampleMissing = (id: string) => isUser(id) && !(id in app.userSamples);

export async function openProjectFile(file: File): Promise<void> {
  if (file.size > 200 * 1024 * 1024) { toast('That file is too big to be a Loopwell project.', 'error'); return; }
  await openProjectBytes(new Uint8Array(await file.arrayBuffer()));
}

/** Open the contents of a .loopwell file. Returns false (after saying why) if it isn't one. */
export async function openProjectBytes(bytes: Uint8Array, quiet = false): Promise<boolean> {
  try {
    const { project, samples } = unpackProjectFile(bytes);
    for (const s of samples) await registerSample(s, true);
    loadProject(project);
    if (!quiet) toast(`Opened “${project.name}”`);
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not open that file.', 'error');
    return false;
  }
}

/** The beat on screen as a .loopwell file, custom samples included. */
export function projectFileBytes(): Uint8Array<ArrayBuffer> {
  return packProjectFile(snapshot(), [...userBytes.values()]);
}

export function saveProjectFile(): void {
  download(projectFileBytes(), `${slug()}.loopwell`, 'application/zip');
  toast('Project file saved');
}

// --- sharing & export ------------------------------------------------------

export function shareUrl(): string {
  return beatUrl(snapshot(), location.href);
}

/** How many tracks use samples that can't travel in a link. */
export function customSampleCount(): number {
  return app.project.tracks.filter((t) => usesSample(t.kind) && isUser(t.sample)).length;
}

/** Song view exports the timeline; pattern view exports the pattern on screen, once through. */
const exportChain = () => (app.project.songMode ? undefined : [app.pat]);

/** Does track `i` play anything in what is about to be exported? */
function trackHasNotes(p: Project, i: number, chain: number[] | undefined): boolean {
  const pats = chain ?? p.arr.clips.filter((c) => c.track === i).map((c) => c.pattern);
  return pats.some((c) => (usesNotes(p.tracks[i].kind) ? p.patterns[c].notes[i].length > 0 : p.patterns[c].steps[i].some((v) => v > 0)));
}

async function withBusy(label: string, job: (progress: (p: number) => Promise<void>) => Promise<void>): Promise<void> {
  if (app.busy) return;
  app.busy = { label, progress: 0 };
  await nextPaint();
  try {
    await job(async (p) => { if (app.busy) app.busy.progress = p; await nextPaint(); });
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Export failed.', 'error');
  } finally {
    app.busy = null;
  }
}

async function loadAllSamples(p: Project): Promise<void> {
  await audio.init();
  await Promise.all(p.tracks.filter((t) => usesSample(t.kind)).map((t) => audio.ensure(t.sample)));
}

export type AudioFormat = 'wav' | Codec;

/** Render the mix and save it. `loudness` scales the whole file towards a target; nothing is compressed to get there. */
export function exportAudio(format: AudioFormat = 'wav', loudness: LoudnessTarget = 'off', quality = 1): Promise<void> {
  const label = format === 'wav' ? 'WAV' : CODECS[format].label;
  return withBusy(`Rendering ${label}`, async (progress) => {
    const p = snapshot();
    await loadAllSamples(p);
    const encoding = format !== 'wav';
    const r = await renderProject(p, audio.bank, { sampleRate: audio.sampleRate, chain: exportChain(), onProgress: (d) => progress(encoding ? d * 0.6 : d) });
    const n = normalize(r.l, r.r, r.sampleRate, loudness);
    let bytes: Uint8Array<ArrayBuffer>;
    if (format === 'wav') bytes = encodeWav([r.l, r.r], r.sampleRate, 24);
    else {
      if (app.busy) app.busy.label = `Encoding ${label}`;
      // the encoder is WebAssembly, fetched the first time it is needed
      const wasm = (format === 'mp3' ? await import('wasm-media-encoders/wasm/mp3?url') : await import('wasm-media-encoders/wasm/ogg?url')).default;
      bytes = await encodeAudio(format, r.l, r.r, r.sampleRate, quality, new URL(wasm, location.href).href, (d) => progress(0.6 + d * 0.4));
    }
    download(bytes, `${slug()}.${format === 'wav' ? 'wav' : CODECS[format].ext}`, format === 'wav' ? 'audio/wav' : CODECS[format].mime);
    const said = loudness === 'off' ? '' : n.gain === 1 && n.to <= -70 ? '' : ` at ${n.to.toFixed(1)} LUFS${n.limited ? ' (as loud as it goes without clipping)' : ''}`;
    toast(`${label} exported${said}`);
  });
}

export const exportWav = (): Promise<void> => exportAudio('wav');

export function exportStems(): Promise<void> {
  return withBusy('Rendering stems', async (progress) => {
    const p = snapshot();
    await loadAllSamples(p);
    const chain = exportChain();
    const active = p.tracks.map((t, i) => i).filter((i) => trackHasNotes(p, i, chain));
    if (!active.length) throw new Error(`Nothing to export yet: the ${chain ? 'pattern' : 'song'} is empty.`);
    const files: Record<string, Uint8Array> = {};
    for (let k = 0; k < active.length; k++) {
      const i = active[k];
      const r = await renderProject(p, audio.bank, {
        sampleRate: audio.sampleRate, chain, stem: i,
        onProgress: (d) => progress((k + d) / active.length),
      });
      const name = p.tracks[i].name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'track';
      files[`${String(i + 1).padStart(2, '0')}-${name}.wav`] = encodeWav([r.l, r.r], r.sampleRate, 24);
      await progress((k + 1) / active.length);
    }
    download(zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>, `${slug()}-stems.zip`, 'application/zip');
    toast(`${active.length} stems exported`);
  });
}

export function exportMidiFile(): void {
  download(exportMidi(snapshot(), exportChain()), `${slug()}.mid`, 'audio/midi');
  toast('MIDI exported');
}

// --- startup ---------------------------------------------------------------

async function openLink(p: Project): Promise<void> {
  loadProject(p);
  history.replaceState(null, '', location.pathname + location.search);
  if (customSampleCount()) toast('This beat uses custom samples that links can\'t carry. Those tracks are silent.', 'error');
  await loadAllSamples(p);
  if (await audio.resume()) await play();
  else app.needsTap = true; // the browser wants a tap before it lets us make sound
}

function checkHash(): void {
  if (!new RegExp(`[#&]${HASH_KEY}=`).test(location.hash)) return;
  const p = beatFromHash(location.hash);
  if (p) void openLink(p);
  else {
    history.replaceState(null, '', location.pathname + location.search);
    toast('That link is damaged, or was made by a newer version of Loopwell.', 'error');
  }
}

export function boot(): void {
  setTheme(loadTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'cream'));
  const saved = loadSaved();
  app.firstRun = !saved;
  app.project = saved ? sanitize(saved) : starter();
  fixSelection();
  commit('Where you left off');
  startVisuals();
  applyPrefs();
  void audio.init().catch(() => toast('This browser can\'t run the audio engine (AudioWorklet is missing).', 'error'));
  void getSamples().then(async (all) => { for (const s of all) await registerSample(s, false); });
  checkHash();
  addEventListener('hashchange', checkHash);
  void initCommunity();
  void onProjectOpened((bytes, name) => void openProjectBytes(bytes).then((ok) => log(ok ? `opened ${name}: "${app.project.name}", ${app.project.tracks.length} tracks` : `could not open ${name}`)));
  if (isDesktop) void audio.init().then(() => log(`ready: audio ${audio.ctx?.state}, ${audio.sampleRate} Hz, latency ${Math.round(audio.latency * 1000)} ms`));
}
