// Pattern tools: Euclidean fills, step extras, chords, and the dice.

import { audio } from './audio/host';
import { chordPitches, type Chord } from './core/chords';
import { euclid, makeMod, modChance, modCond, modRatchet } from './core/creative';
import { ALL_SAMPLES, isBuiltin } from './core/kits';
import { MOD_DESTS } from './core/dsp/voices';
import { degreeToPitch, snapToScale } from './core/scales';
import { DEFAULT_VEL, LFO_SHAPES, MAX_STEPS, NUM_WAVES, clamp, usesNotes, type Note, type SynthParams } from './core/types';
import { assignSample, checkpoint } from './actions.svelte';
import { app } from './state.svelte';

const rand = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
const chance = (p: number) => Math.random() < p;

// --- Euclidean rhythms -----------------------------------------------------

/**
 * Write a Euclidean rhythm onto a track of the pattern on screen. A cycle shorter
 * than the pattern repeats to fill it, which is where the cross-rhythms come from.
 */
export function applyEuclid(t: number, steps: number, pulses: number, rotation: number, pat = app.pat): void {
  const p = app.project, tr = p.tracks[t], pattern = p.patterns[pat];
  if (!tr) return;
  checkpoint(); // its own undo step, whatever was being edited a moment ago
  const cycle = euclid(steps, pulses, rotation);
  const row = pattern.steps[t];
  if (!usesNotes(tr.kind)) {
    for (let s = 0; s < MAX_STEPS; s++) {
      const on = s < p.steps && cycle[s % cycle.length];
      // a step that stays on keeps the velocity it had
      row[s] = on ? row[s] || DEFAULT_VEL : 0;
      if (!on) pattern.mods[t][s] = 0;
    }
    return;
  }
  const notes: Note[] = [];
  for (let s = 0; s < p.steps; s++) {
    if (!cycle[s % cycle.length]) continue;
    const here = pattern.notes[t].filter((n) => n.s === s);
    if (here.length) notes.push(...here);
    else notes.push({ s, l: 1, p: tr.note, v: DEFAULT_VEL });
  }
  pattern.notes[t] = notes;
}

// --- step extras -----------------------------------------------------------

export const stepMod = (t: number, s: number, pat = app.pat) => app.project.patterns[pat].mods[t]?.[s] ?? 0;

export function setStepMod(t: number, s: number, part: { ratchet?: number; chance?: number; cond?: number }, pat = app.pat): void {
  const row = app.project.patterns[pat].mods[t];
  if (!row) return;
  const m = row[s];
  row[s] = makeMod(part.ratchet ?? modRatchet(m), part.chance ?? modChance(m), part.cond ?? modCond(m));
}

/** Hold a fill: "fill only" steps play until it is let go. */
export function setFill(on: boolean): void {
  if (app.fill === on) return;
  app.fill = on;
  audio.setFill(on);
}

// --- chords ----------------------------------------------------------------

/** Put a chord on the selected track at a step, replacing whatever started there. */
export function insertChord(chord: Chord, step: number, len: number, octaveBase: number, inversion = 0, t = app.sel, pat = app.pat): void {
  const p = app.project, tr = p.tracks[t];
  if (!tr || tr.kind !== 'synth') return;
  checkpoint();
  const s = clamp(step, 0, p.steps - 1);
  const l = clamp(len, 1, p.steps - s);
  const pitches = chordPitches(chord, p.scaleRoot, octaveBase, inversion);
  const notes = p.patterns[pat].notes[t].filter((n) => n.s !== s);
  for (const pitch of pitches) notes.push({ s, l, p: pitch, v: DEFAULT_VEL });
  p.patterns[pat].notes[t] = notes;
  for (const pitch of pitches) audio.trigger(t, 96, pitch);
}

// --- the dice --------------------------------------------------------------

const KICKS = ['kick', 'sub'], SNARES = ['snare', 'clap', 'rim'], HATS = ['hat', 'open'];

function randomDrums(t: number, pat: number): void {
  const p = app.project, tr = p.tracks[t], n = p.steps;
  const slot = isBuiltin(tr.sample) ? tr.sample.split('/')[1] : '';
  const row = new Array<number>(MAX_STEPS).fill(0);
  if (KICKS.includes(slot)) {
    // a kick wants the downbeat, then a few pushes around it
    for (let s = 0; s < n; s += 16) row[s] = DEFAULT_VEL;
    for (let s = 0; s < n; s++) if (!row[s] && chance(s % 4 === 0 ? 0.45 : s % 2 === 0 ? 0.16 : 0.07)) row[s] = s % 4 === 0 ? DEFAULT_VEL : rand(70, 100);
  } else if (SNARES.includes(slot)) {
    for (let s = 4; s < n; s += 8) row[s] = DEFAULT_VEL;
    for (let s = 0; s < n; s++) if (!row[s] && chance(0.07)) row[s] = rand(35, 70); // ghost notes
  } else if (HATS.includes(slot)) {
    const cycle = euclid(16, slot === 'open' ? rand(1, 3) : rand(6, 14), slot === 'open' ? 2 : 0);
    for (let s = 0; s < n; s++) if (cycle[s % 16]) row[s] = s % 4 === 0 ? DEFAULT_VEL : rand(55, 90);
  } else {
    const len = pick([8, 12, 16, 16]);
    const cycle = euclid(len, rand(1, Math.max(2, len / 3)), rand(0, len - 1));
    for (let s = 0; s < n; s++) if (cycle[s % len]) row[s] = rand(70, 110);
  }
  p.patterns[pat].steps[t] = row;
  p.patterns[pat].mods[t] = new Array<number>(MAX_STEPS).fill(0);
}

/** A new line in key. `keep` holds on to the rhythm that is there and only rolls new pitches, or the other way round. */
function randomNotes(t: number, pat: number, keep: 'none' | 'rhythm' | 'pitch'): void {
  const p = app.project, tr = p.tracks[t];
  const old = [...p.patterns[pat].notes[t]].sort((a, b) => a.s - b.s);
  const slice = tr.kind === 'slice';
  const count = Math.max(1, tr.slices.length);
  let degree = 0;
  const pitch = () => {
    if (slice) return rand(0, count - 1);
    // mostly small steps, now and then a leap, drifting back towards the root
    degree = clamp(degree + (chance(0.2) ? rand(-4, 4) : rand(-2, 2)) - Math.sign(degree) * (chance(0.3) ? 1 : 0), -7, 9);
    return clamp(degreeToPitch(p.scaleRoot, p.scaleType, tr.note, degree), 0, 127);
  };
  if (keep === 'rhythm' && old.length) {
    // notes that start together (a chord) move together
    let last = -1, shift = 0;
    for (const n of old) {
      if (n.s !== last) { shift = pitch() - n.p; last = n.s; }
      n.p = slice ? clamp(n.p + shift, 0, count - 1) : snapToScale(clamp(n.p + shift, 0, 127), p.scaleRoot, p.scaleType);
    }
    p.patterns[pat].notes[t] = old;
    return;
  }
  const len = pick([8, 16, 16]);
  const cycle = euclid(len, rand(3, Math.max(4, len / 2)), rand(0, 3));
  const starts: number[] = [];
  for (let s = 0; s < p.steps; s++) if (cycle[s % len]) starts.push(s);
  const pitches = keep === 'pitch' && old.length ? old.map((n) => n.p) : null;
  p.patterns[pat].notes[t] = starts.map((s, i) => {
    const room = (starts[i + 1] ?? p.steps) - s;
    return { s, l: slice ? room : clamp(pick([1, 1, 2, room]), 1, room), p: pitches ? pitches[i % pitches.length] : pitch(), v: rand(80, 112) };
  });
  p.patterns[pat].mods[t] = new Array<number>(MAX_STEPS).fill(0);
}

/** Roll a new part for every track that isn't locked. */
export function randomizePattern(pat = app.pat): number {
  checkpoint();
  let n = 0;
  app.project.tracks.forEach((tr, t) => {
    if (app.locks[t]) return;
    if (usesNotes(tr.kind)) randomNotes(t, pat, 'none'); else randomDrums(t, pat);
    n++;
  });
  return n;
}

/** Roll one track's part. On a track played by notes, `keep` can hold the rhythm or the pitches still. */
export function randomizeTrack(t = app.sel, keep: 'none' | 'rhythm' | 'pitch' = 'none', pat = app.pat): void {
  const tr = app.project.tracks[t];
  if (!tr) return;
  checkpoint();
  if (usesNotes(tr.kind)) randomNotes(t, pat, keep); else randomDrums(t, pat);
}

export const SOUND_PARTS = ['osc', 'filter', 'env', 'mod'] as const;
export type SoundPart = (typeof SOUND_PARTS)[number];
export const SOUND_PART_LABELS: Record<SoundPart, string> = { osc: 'Oscillators', filter: 'Filter', env: 'Envelope', mod: 'Movement' };

/** A new sound for a track, leaving the locked parts as they are. A drum track gets another sample from the built-in kits. */
export function randomizeSound(t = app.sel, locked: Partial<Record<SoundPart, boolean>> = {}): void {
  const tr = app.project.tracks[t];
  if (!tr) return;
  checkpoint();
  if (tr.kind !== 'synth') {
    if (tr.kind === 'drum' && !locked.osc) {
      const slot = isBuiltin(tr.sample) ? tr.sample.split('/')[1] : '';
      const same = ALL_SAMPLES.filter((id) => id !== tr.sample && (!slot || id.endsWith(`/${slot}`)));
      const name = tr.name;
      assignSample(t, pick(same.length ? same : ALL_SAMPLES));
      tr.name = name;
    }
    if (!locked.env) { tr.tune = rand(-5, 5); tr.decay = chance(0.5) ? 127 : rand(50, 120); }
    if (!locked.filter) tr.filter = chance(0.6) ? 0 : rand(-30, 30);
    return;
  }
  const s: SynthParams = tr.synth;
  if (!locked.osc) {
    s.wave = rand(0, NUM_WAVES - 1); s.pos = rand(0, 127);
    s.wave2 = rand(0, NUM_WAVES - 1); s.pos2 = rand(0, 127);
    s.semi2 = pick([0, 0, 0, 7, 12, -12, 19]); s.fine2 = rand(-12, 12);
    s.mix = chance(0.4) ? 0 : rand(20, 100); s.noise = chance(0.75) ? 0 : rand(5, 40);
    s.uni = rand(1, 4); s.detune = rand(4, 40); s.spread = rand(0, 110);
  }
  if (!locked.filter) { s.cutoff = rand(30, 115); s.reso = rand(5, 80); s.env = rand(0, 100); }
  if (!locked.env) {
    s.attack = chance(0.7) ? rand(0, 8) : rand(8, 70);
    s.decay = rand(25, 100); s.sustain = rand(0, 110); s.release = rand(10, 90);
  }
  if (!locked.mod) {
    s.lfoShape = rand(0, LFO_SHAPES.length - 1); s.lfoSync = chance(0.6); s.lfoRate = rand(20, 110);
    s.lfoAmt = chance(0.4) ? 0 : rand(-40, 40); s.lfoDest = rand(0, MOD_DESTS.length - 1);
    s.menvAttack = rand(0, 30); s.menvDecay = rand(20, 90);
    s.menvAmt = chance(0.5) ? 0 : rand(-45, 45); s.menvDest = rand(0, MOD_DESTS.length - 1);
  }
  audio.trigger(t, 100, tr.note);
}
