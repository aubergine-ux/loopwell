// Ideas to notes: hum a melody, tap a rhythm, fit a loop to the song.

import { checkpoint, padHooks, toast } from './actions.svelte';
import { audio } from './audio/host';
import { fitLoop, hearNotes, notesFromHeard, tapsToSteps } from './core/ideas';
import { clamp, isPitched, usesNotes, usesSample } from './core/types';
import { analyze } from './library.svelte';
import { app } from './state.svelte';

const MAX_HUM_SECONDS = 20;
/** A tapped rhythm is taken to be finished after this long with no tap. */
const TAP_REST = 2200;

export const ideas = $state({
  /** A hum being recorded: the track it is for, and how long it has run. */
  humming: null as { track: number; seconds: number } | null,
  /** Input level of the hum, 0..1. */
  level: 0,
  /** A rhythm being tapped: the track it is for, and the taps so far. */
  tapping: null as { track: number; count: number } | null,
  /** Work the tempo out from the taps and set the song to it, rather than reading them at the song's tempo. */
  tapTempo: false,
});

// --- humming ---------------------------------------------------------------

let humTimer = 0;

export async function startHum(t = app.sel): Promise<void> {
  const tr = app.project.tracks[t];
  if (!tr || !isPitched(tr.kind) || ideas.humming || app.recording) return;
  try {
    await audio.startRecording();
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    toast(name === 'NotAllowedError' ? 'Humming a melody needs permission to use the microphone.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone was found.'
      : e instanceof Error ? e.message : 'Could not start listening.', 'error');
    return;
  }
  ideas.humming = { track: t, seconds: 0 };
  humTimer = window.setInterval(() => {
    if (!ideas.humming) return;
    ideas.humming.seconds = audio.recSeconds;
    ideas.level = audio.recLevel;
    if (audio.recSeconds >= MAX_HUM_SECONDS) void stopHum();
  }, 80);
}

/** Stop listening and write what was hummed onto the track as notes. Returns how many notes there were. */
export async function stopHum(): Promise<number> {
  const hum = ideas.humming;
  if (!hum) return 0;
  clearInterval(humTimer);
  ideas.humming = null;
  ideas.level = 0;
  const take = await audio.stopRecording();
  const p = app.project, tr = p.tracks[hum.track];
  if (!take || !tr) { toast('Nothing was heard. Check the microphone and try again.', 'error'); return 0; }
  const heard = hearNotes(take.l, take.sampleRate);
  const notes = notesFromHeard(heard, {
    bpm: p.bpm, steps: p.steps, around: tr.note + 6,
    scale: p.scaleLock ? { root: p.scaleRoot, type: p.scaleType } : null,
  });
  if (!notes.length) {
    toast(heard.length ? 'That was too quick to turn into notes. Hum each note a little longer.' : 'No melody was heard. Hum or sing clear notes, close to the microphone.', 'error');
    return 0;
  }
  checkpoint();
  p.patterns[app.pat].notes[hum.track] = notes;
  p.patterns[app.pat].mods[hum.track].fill(0);
  toast(`${notes.length} note${notes.length === 1 ? '' : 's'} from your melody${p.scaleLock ? ', snapped to the key' : ''}. Undo takes them away.`);
  return notes.length;
}

export function toggleHum(): void {
  if (ideas.humming) void stopHum(); else void startHum();
}

// --- tapping ---------------------------------------------------------------

let taps: number[] = [];
let vels: number[] = [];
let tapTimer = 0;

export function startTap(t = app.sel): void {
  const tr = app.project.tracks[t];
  if (!tr || usesNotes(tr.kind)) return;
  taps = [];
  vels = [];
  ideas.tapping = { track: t, count: 0 };
}

/** One tap, now. Called by the tap button, and by any pad or pad key hit while a rhythm is being tapped. */
export function tap(vel = 100): void {
  if (!ideas.tapping) return;
  taps.push(performance.now() / 1000);
  vels.push(vel);
  ideas.tapping.count = taps.length;
  clearTimeout(tapTimer);
  tapTimer = window.setTimeout(finishTap, TAP_REST);
}

/** Turn the taps into steps on the track. */
export function finishTap(): void {
  const tapping = ideas.tapping;
  clearTimeout(tapTimer);
  ideas.tapping = null;
  if (!tapping) return;
  const p = app.project, tr = p.tracks[tapping.track];
  if (!tr || usesNotes(tr.kind)) return;
  const got = tapsToSteps(taps, vels, p.steps, ideas.tapTempo ? undefined : p.bpm);
  if (!got) { toast(taps.length ? 'Tap at least twice, so there is a rhythm to hear.' : 'Nothing was tapped.'); return; }
  checkpoint();
  if (ideas.tapTempo) p.bpm = clamp(Math.round(got.bpm), 40, 240);
  p.patterns[app.pat].steps[tapping.track] = got.steps;
  p.patterns[app.pat].mods[tapping.track].fill(0);
  const hits = got.steps.filter((v) => v > 0).length;
  toast(`${hits} hit${hits === 1 ? '' : 's'} on ${tr.name}${ideas.tapTempo ? ` at ${p.bpm} bpm` : ''}. Undo takes them away.`);
}

export function cancelTap(): void {
  clearTimeout(tapTimer);
  ideas.tapping = null;
}

// while a rhythm is being tapped, every pad that is hit counts as a tap
padHooks.push((_t, vel) => { if (ideas.tapping) tap(vel); });

// --- loops -----------------------------------------------------------------

export interface LoopInfo { bpm: number; beats: number }

/** Is the track's sample a loop with a tempo? Looks at the audio the first time it is asked. */
export async function loopInfo(t = app.sel): Promise<LoopInfo | null> {
  const tr = app.project.tracks[t];
  if (!tr || !usesSample(tr.kind)) return null;
  const info = await analyze(tr.sample);
  if (!info?.bpm) return null;
  const fit = fitLoop(info.seconds, info.bpm, app.project.steps);
  return fit ? { bpm: fit.bpm, beats: fit.beats } : null;
}

/**
 * Cut the track's loop to the beat and play it in time with the song: sliced on every 8th note, a note for each
 * slice, and stretched so each slice lasts as long as its place in the bar. With `follow`, the song takes the
 * loop's tempo instead and nothing is stretched.
 */
export async function fitLoopToSong(t = app.sel, follow = false): Promise<boolean> {
  const p = app.project, tr = p.tracks[t];
  if (!tr || !usesSample(tr.kind)) return false;
  const info = await analyze(tr.sample);
  const fit = info?.bpm ? fitLoop(info.seconds, info.bpm, p.steps) : null;
  if (!fit) { toast('That sound has no steady tempo to fit: it looks like a single hit rather than a loop.'); return false; }
  checkpoint();
  if (follow) p.bpm = clamp(Math.round(fit.bpm), 40, 240);
  tr.kind = 'slice';
  tr.slices = fit.slices;
  tr.note = 0;
  tr.decay = 127;
  tr.reverse = false;
  // 64 is "as recorded"; each 32 either way doubles or halves the length
  tr.stretch = clamp(Math.round(64 + 32 * Math.log2(fit.bpm / p.bpm)), 0, 127);
  p.patterns[app.pat].notes[t] = fit.notes;
  p.patterns[app.pat].steps[t].fill(0);
  p.patterns[app.pat].mods[t].fill(0);
  const bars = fit.beats / 4;
  toast(`${tr.name}: a ${bars >= 1 ? `${bars}-bar` : `${fit.beats}-beat`} loop at ${fit.bpm} bpm, cut into ${fit.slices.length} slices${follow ? `; the song is now ${p.bpm} bpm` : ` and fitted to ${p.bpm} bpm`}.${fit.steps > p.steps ? ` Only the first ${p.steps} steps fit this pattern.` : ''}`);
  return true;
}
