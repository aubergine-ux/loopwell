// What changed between two versions of a beat, in a few words: for the undo history and the log of a live
// session. Plain comparisons, kept apart from the live-session code so that using them brings nothing else in.

import { NUM_PATTERNS, type Project } from './types';

type Json = Record<string, unknown>;

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
  if (before.code !== after.code || before.codeOn !== after.codeOn) say('code');
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
