// Playing live: the clip launcher, the performance effects, and recording a
// performance onto the timeline.

import { checkpoint, play, resetHooks, setView, stopPlaying, toast } from './actions.svelte';
import { audio } from './audio/host';
import { launchesToClips, samplesToLane, type LaunchEvent } from './core/performance';
import { resolveOverlaps, type AutoPoint } from './core/types';
import { app } from './state.svelte';

export const LAUNCH_OFF = -2;
export const LAUNCH_FOLLOW = -1;
/** How long a launch waits, in steps. 0 = no waiting. */
export const QUANTS = [{ label: 'Bar', steps: 16 }, { label: 'Beat', steps: 4 }, { label: '1/16', steps: 1 }, { label: 'Now', steps: 0 }];

export const stage = $state({
  /** What each track is set to loop: a pattern, LAUNCH_OFF or LAUNCH_FOLLOW. */
  playing: [] as number[],
  /** Launches waiting for their quantize line, by track; undefined = none. */
  queued: [] as (number | undefined)[],
  quant: 16,
  fx: 0,
  fxOn: false,
  /** Keep the effect on after the finger lifts. */
  latch: false,
  x: 0.5,
  y: 0.5,
  rec: false,
  /** Steps recorded so far. */
  recSteps: 0,
});

const setting = (t: number) => stage.playing[t] ?? LAUNCH_FOLLOW;
/** The pattern a track is looping right now (or LAUNCH_OFF). */
export const patternOn = (t: number) => (setting(t) === LAUNCH_FOLLOW ? app.pat : setting(t));

export function launchClip(track: number, pattern: number): void {
  const quant = app.playing && !app.project.songMode ? stage.quant : 0;
  if (quant && patternOn(track) !== pattern) stage.queued[track] = pattern;
  else { stage.playing[track] = pattern; stage.queued[track] = undefined; }
  audio.launch(track, pattern, quant);
}

/** A whole row at once: every track goes to this pattern. */
export function launchScene(pattern: number): void {
  for (let t = 0; t < app.project.tracks.length; t++) launchClip(t, pattern);
  if (!app.playing) void startStage();
}

export function stopTrack(track: number): void {
  launchClip(track, LAUNCH_OFF);
}

/** Back to how a beat normally plays: every track follows the selected pattern. */
export function releaseAll(): void {
  for (let t = 0; t < 8; t++) {
    stage.playing[t] = LAUNCH_FOLLOW;
    stage.queued[t] = undefined;
    audio.launch(t, LAUNCH_FOLLOW, 0);
  }
}

/** The launcher plays looping patterns, so it starts in pattern view. */
export async function startStage(): Promise<void> {
  if (app.project.songMode) setView(false);
  if (!app.playing) await play();
}

// another beat has other patterns: nothing launched for the old one carries over
resetHooks.push(() => { stage.rec = false; releaseAll(); });

// --- performance effects ---------------------------------------------------

function sendFx(): void {
  audio.perf(stage.fx, stage.fxOn, stage.x, stage.y);
}

export function setFx(fx: number): void {
  stage.fx = fx;
  sendFx();
}

/** A finger (or a controller) on the pad. */
export function fxMove(x: number, y: number, on = true): void {
  stage.x = Math.min(1, Math.max(0, x));
  stage.y = Math.min(1, Math.max(0, y));
  stage.fxOn = on;
  sendFx();
}

export function fxRelease(): void {
  if (stage.latch) return;
  stage.fxOn = false;
  sendFx();
}

export function fxToggle(on = !stage.fxOn): void {
  stage.fxOn = on;
  sendFx();
}

// --- recording a performance -----------------------------------------------

let log: LaunchEvent[] = [];
let sweep: AutoPoint[] = [];
let reso: AutoPoint[] = [];
let recFrom = 0;
let now: number[] = [];

audio.onLaunched = (tracks, count) => {
  now = [...tracks];
  // what the engine says is playing is the truth; anything queued for those tracks has landed
  for (let t = 0; t < tracks.length; t++) {
    if (stage.queued[t] !== undefined && tracks[t] === stage.queued[t]) {
      stage.playing[t] = stage.queued[t]!;
      stage.queued[t] = undefined;
    }
  }
  if (stage.rec) log.push({ at: count, tracks: now });
};

/** Once per step while recording: note where the filter pad is. */
function recordTick(count: number): void {
  if (!stage.rec) return;
  stage.recSteps = count - recFrom + 1;
  const on = stage.fxOn && stage.fx === 0;
  sweep.push({ t: count, v: on ? Math.round(stage.x * 127 - 64) : app.project.fx.filter });
  reso.push({ t: count, v: on ? Math.round(stage.y * 127) : app.project.fx.filterRes });
}

audio.onStepFired = () => recordTick(audio.count);

export async function startRecording(): Promise<void> {
  if (stage.rec) return;
  await startStage();
  if (!app.playing) return;
  recFrom = audio.count;
  const tracks = app.project.tracks.map((_, t) => patternOn(t));
  log = [{ at: recFrom, tracks: now.length ? now.slice(0, tracks.length) : tracks }];
  sweep = [];
  reso = [];
  stage.recSteps = 0;
  stage.rec = true;
}

/** Stop recording and lay what was played out on the timeline. One undo brings the old arrangement back. */
export function finishRecording(): void {
  if (!stage.rec) return;
  stage.rec = false;
  const p = app.project;
  const to = audio.count + 1;
  if (to - recFrom < 2) { toast('Nothing was recorded.'); return; }
  const clips = launchesToClips(log, recFrom, to, p.steps, p.tracks.length);
  if (!clips.length) { toast('Nothing was playing, so there is nothing to put on the timeline.'); return; }
  const origin = recFrom - (recFrom % p.steps);
  checkpoint();
  stopPlaying();
  const lanes = p.arr.lanes.filter((l) => !(l.track === -1 && (l.param === 'mfilter' || l.param === 'mres')));
  const f = samplesToLane(sweep, -1, 'mfilter', origin, p.fx.filter);
  if (f) {
    lanes.push(f);
    const r = samplesToLane(reso, -1, 'mres', origin, p.fx.filterRes);
    if (r) lanes.push(r);
  }
  p.arr = { ...p.arr, clips: resolveOverlaps(clips, p.steps), lanes, loopOn: false, loopStart: 0, loopEnd: 0 };
  app.cursor = 0;
  app.clip = null;
  releaseAll();
  app.perform = app.stage = false;
  setView(true);
  const bars = Math.round(Math.max(...clips.map((c) => c.start + c.len)) / 16);
  toast(`Your performance is on the timeline: ${bars} bar${bars === 1 ? '' : 's'}${f ? ', with the filter sweep as automation' : ''}. Undo brings the old song back.`);
}

export function toggleRecording(): void {
  if (stage.rec) finishRecording(); else void startRecording();
}
