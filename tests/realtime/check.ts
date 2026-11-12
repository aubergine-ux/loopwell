// Runs in a real browser (see scripts/realtime-check.ts). Plays the stress
// project through the actual AudioWorklet while the main thread is repeatedly
// frozen, then checks that every step still fired on its exact audio frame.

import { audio } from '../../src/audio/host';
import { samplesPerStep, swingOffset } from '../../src/core/clock';
import { stressProject } from './stress';

const SECONDS = 12;
const p = stressProject();
const frames: number[] = [];
const arrivals: number[] = [];
let load = 0, loadMax = 0, loadN = 0;

const done = (async () => {
  await audio.init();
  await Promise.all(p.tracks.filter((t) => t.kind === 'drum').map((t) => audio.ensure(t.sample)));
  audio.setProject(p);
  await audio.resume();
  audio.onStepFired = (_s, frame) => { frames.push(frame); arrivals.push(performance.now()); };
  const ctx = audio.ctx!;
  audio.play(0);

  const end = performance.now() + SECONDS * 1000;
  let freezes = 0, longest = 0;
  while (performance.now() < end) {
    // freeze the main thread for 150-400ms, the kind of jank a heavy UI could cause
    const ms = 150 + Math.random() * 250;
    const t = performance.now();
    let x = 0;
    while (performance.now() - t < ms) x += Math.sqrt(x + 1);
    freezes++;
    longest = Math.max(longest, performance.now() - t);
    await new Promise((r) => requestAnimationFrame(r));
    load += audio.load; loadMax = Math.max(loadMax, audio.load); loadN++;
  }
  audio.stop();
  await new Promise((r) => setTimeout(r, 200));

  const sps = samplesPerStep(p.bpm, ctx.sampleRate);
  let worst = 0;
  for (let i = 0; i < frames.length; i++) {
    const want = frames[0] + Math.round(i * sps + swingOffset(i, p.swing, sps));
    worst = Math.max(worst, Math.abs(frames[i] - want));
  }
  // how late the main thread heard about steps: this is what would have been the
  // timing error if the sequencer had been scheduled from the main thread
  let lateMax = 0;
  const t0 = arrivals[0] - (frames[0] / ctx.sampleRate) * 1000;
  for (let i = 0; i < frames.length; i++) lateMax = Math.max(lateMax, arrivals[i] - t0 - (frames[i] / ctx.sampleRate) * 1000);
  const stats = (ctx as any).playbackStats;
  return {
    sampleRate: ctx.sampleRate,
    steps: frames.length,
    expectedSteps: Math.floor((SECONDS * ctx.sampleRate) / sps),
    worstErrorFrames: worst,
    mainThreadFreezes: freezes,
    longestFreezeMs: Math.round(longest),
    mainThreadLatenessMs: Math.round(lateMax),
    dspLoadAvg: +(load / loadN).toFixed(3),
    dspLoadMax: +loadMax.toFixed(3),
    underruns: stats ? stats.underrunEvents ?? stats.fallbackFramesEvents ?? null : null,
  };
})();

done.then((r) => {
  document.getElementById('out')!.textContent = JSON.stringify(r, null, 2);
  (window as any).__result = r;
}, (e) => { (window as any).__result = { error: String(e) }; });
