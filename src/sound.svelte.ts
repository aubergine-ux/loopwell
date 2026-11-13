// Sound design actions: slicing, synth presets, effect racks and recording.

import { hashId, registerSample, toast } from './actions.svelte';
import { audio } from './audio/host';
import type { InsertType } from './core/dsp/inserts';
import { PRESETS, type Preset } from './core/presets';
import { MAX_SLICES, detectSlices, equalSlices, toFraction } from './core/slicer';
import { MAX_INSERTS, MAX_STEPS, newInsert, sanitize, synth, usesNotes, usesSample, type SynthParams, type TrackKind } from './core/types';
import { encodeWav } from './core/wav';
import { app } from './state.svelte';
import { flash } from './visual';

const track = (t: number) => app.project.tracks[t];

// --- sampler ---

/** Switch what a track is. A sample that becomes sliced gets its hits detected straight away. */
export function setKind(t: number, kind: TrackKind): void {
  const tr = track(t);
  if (!tr || tr.kind === kind) return;
  const from = tr.kind;
  tr.kind = kind;
  // a drum part and a sliced part are the same hits written two ways, so carry them over
  for (const pat of app.project.patterns) {
    if (!usesNotes(from) && usesNotes(kind) && !pat.notes[t].length) {
      const pitch = kind === 'slice' ? 0 : kind === 'bass' ? 36 : 48;
      pat.notes[t] = pat.steps[t].flatMap((v, s) => (v ? [{ s, l: 1, p: pitch, v }] : []));
    } else if (usesNotes(from) && !usesNotes(kind) && !pat.steps[t].some((v) => v > 0)) {
      for (const n of pat.notes[t]) if (n.s < MAX_STEPS) pat.steps[t][n.s] = Math.max(pat.steps[t][n.s], n.v);
    }
  }
  if (kind === 'slice') {
    tr.note = 0;
    if (!tr.slices.length) void autoSlice(t);
  } else if (kind === 'synth' && tr.note < 12) tr.note = 48;
  else if (kind === 'bass') {
    // the 808 starts on the root of the song's key, down where a bass lives
    tr.bass.key = app.project.scaleRoot;
    tr.note = 36 + ((app.project.scaleRoot + 6) % 12) - 6;
    if (from !== 'synth') for (const pat of app.project.patterns) for (const n of pat.notes[t]) n.p = tr.note;
  }
}

/** Find the hits in the track's sample and put a slice on each. Returns how many it found. */
export async function autoSlice(t: number, sensitivity = 0.5): Promise<number> {
  const tr = track(t);
  if (!tr) return 0;
  await audio.ensure(tr.sample);
  const data = audio.bank[tr.sample];
  if (!data) return 0;
  const frames = detectSlices(data.l, data.r, audio.sampleRate, sensitivity);
  tr.slices = frames.map((f) => toFraction(f, data.l.length));
  tr.note = 0;
  return frames.length;
}

export function sliceEvenly(t: number, count: number): void {
  const tr = track(t);
  if (!tr) return;
  tr.slices = equalSlices(65536, Math.min(MAX_SLICES, count));
  tr.note = 0;
}

/** Add a slice at a 0..65535 position, unless one is already right there. */
export function addSlice(t: number, at: number): void {
  const tr = track(t);
  if (!tr || tr.slices.length >= MAX_SLICES || tr.slices.some((s) => Math.abs(s - at) < 96)) return;
  tr.slices = [...tr.slices, Math.round(at)].sort((a, b) => a - b);
}

export function removeSlice(t: number, i: number): void {
  const tr = track(t);
  if (!tr || tr.slices.length <= 1) return;
  tr.slices.splice(i, 1);
}

/** Play one slice now (waveform clicks, slice pads). */
export function auditionSlice(t: number, slice: number, vel = 110): void {
  void audio.resume();
  audio.trigger(t, vel, slice);
  flash(t, vel);
}

// --- synth presets ---

const USER_PRESETS = 'loopwell:presets';

export function userPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_PRESETS) ?? '[]');
    if (!Array.isArray(raw)) return [];
    // run each through the project cleaner, so a hand-edited or outdated entry can't break the synth
    return raw.slice(0, 200).map((x) => {
      const clean = sanitize({ tracks: [{ kind: 'synth', synth: x?.synth, note: x?.note }] }).tracks[0];
      return { name: String(x?.name ?? 'preset').slice(0, 24), group: 'Mine', synth: clean.synth, note: clean.note };
    });
  } catch {
    return [];
  }
}

export function saveUserPreset(name: string, s: SynthParams, note: number): boolean {
  const list = userPresets().filter((x) => x.name !== name);
  list.push({ name: name.slice(0, 24), group: 'Mine', synth: $state.snapshot(s) as SynthParams, note });
  try {
    localStorage.setItem(USER_PRESETS, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function deleteUserPreset(name: string): void {
  try { localStorage.setItem(USER_PRESETS, JSON.stringify(userPresets().filter((x) => x.name !== name))); } catch { /* nothing to do */ }
}

/** Load a preset into a track and play a note so you hear it. */
export function applyPreset(t: number, preset: Preset): void {
  const tr = track(t);
  if (!tr) return;
  tr.kind = 'synth';
  tr.synth = synth(preset.synth);
  tr.note = preset.note;
  void audio.resume();
  // the new settings reach the audio thread on the next tick; play after that
  setTimeout(() => { audio.trigger(t, 100, preset.note); flash(t, 100); }, 30);
}

export const allPresets = (): Preset[] => [...PRESETS, ...userPresets()];

// --- effect rack ---

/** A rack to work on: a track's by its index, or a group's by -1 minus the group's index. */
const rackOf = (t: number) => (t < 0 ? app.project.buses[-1 - t]?.fx : track(t)?.fx);

export function addInsert(t: number, type: InsertType): void {
  const rack = rackOf(t);
  if (!rack || rack.length >= MAX_INSERTS) return;
  const fx = newInsert(type);
  // a new sidechain listens to the first drum track that isn't this one (usually the kick)
  if (type === 'duck') {
    const src = app.project.tracks.findIndex((x, i) => i !== t && x.kind === 'drum');
    fx.p[0] = src >= 0 ? src + 1 : 0;
  }
  rack.push(fx);
}

export function removeInsert(t: number, i: number): void {
  rackOf(t)?.splice(i, 1);
}

export function moveInsert(t: number, from: number, to: number): void {
  const fx = rackOf(t);
  if (!fx || from === to || from < 0 || to < 0 || from >= fx.length || to >= fx.length) return;
  fx.splice(to, 0, ...fx.splice(from, 1));
}

// --- recording ---

let takes = 0;
let recTimer = 0;
const MAX_TAKE_SECONDS = 30;

export async function listInputs(): Promise<{ id: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  } catch {
    return [];
  }
}

/** Start recording onto a track from the microphone or the chosen input. */
export async function startRecording(t: number, deviceId?: string): Promise<void> {
  if (app.recording) return;
  try {
    await audio.startRecording(deviceId);
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    toast(name === 'NotAllowedError' ? 'Recording needs permission to use the microphone.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No audio input was found.'
      : e instanceof Error ? e.message : 'Could not start recording.', 'error');
    return;
  }
  app.recording = { track: t, seconds: 0 };
  recTimer = window.setInterval(() => {
    if (!app.recording) return;
    app.recording.seconds = audio.recSeconds;
    if (audio.recSeconds >= MAX_TAKE_SECONDS) void stopRecording();
  }, 100);
}

/** Stop, trim the silence before the first sound, and put the take on the track. */
export async function stopRecording(): Promise<void> {
  const rec = app.recording;
  if (!rec) return;
  clearInterval(recTimer);
  app.recording = null;
  const take = await audio.stopRecording();
  if (!take) { toast('Nothing was recorded.', 'error'); return; }
  let { l, r } = take;
  let peak = 0;
  for (let i = 0; i < l.length; i++) { const v = Math.abs(l[i]); if (v > peak) peak = v; }
  if (peak < 0.002) { toast('That take was silent. Check the input and its level.', 'error'); return; }
  // start just before the first sound
  const gate = Math.max(0.004, peak * 0.03);
  let first = 0;
  while (first < l.length && Math.abs(l[first]) < gate && (!r || Math.abs(r[first]) < gate)) first++;
  first = Math.max(0, first - Math.round(take.sampleRate * 0.003));
  l = l.subarray(first);
  r = r?.subarray(first);
  const bytes = encodeWav(r ? [l, r] : [l], take.sampleRate, 16);
  const name = `take-${++takes}.wav`;
  const id = hashId(bytes);
  if (!(await registerSample({ id, name, bytes }, true))) { toast('The take could not be saved.', 'error'); return; }
  const tr = track(rec.track);
  if (!tr) return;
  if (!usesSample(tr.kind)) tr.kind = 'drum';
  tr.sample = id;
  tr.slices = [];
  tr.reverse = false;
  if (tr.kind === 'slice') void autoSlice(rec.track);
  tr.name = `TAKE ${takes}`;
  audio.trigger(rec.track, 110);
  flash(rec.track, 110);
  toast(`Recorded ${(l.length / take.sampleRate).toFixed(1)}s onto ${tr.name}`);
}
