// Stress test for the audio engine: a deliberately brutal project (every step
// on, on every track, chords on both synths, all effects up) rendered one
// 128-frame block at a time, the way the AudioWorklet calls it.
// Reports how much of the real-time budget the worst block used.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/core/engine';
import { fullProject, stressProject } from '../tests/realtime/stress';
import { decodeWav } from '../src/core/wav';

const SR = 48000;
const SECONDS = 60;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `--full` adds everything newer than the original stress song, and runs the live-only extras as well
const full = process.argv.includes('--full');
const eng = new Engine(SR);
const p = full ? fullProject() : stressProject();
for (const t of p.tracks) {
  if (t.kind !== 'drum' && t.kind !== 'slice') continue;
  const w = decodeWav(readFileSync(join(root, 'public/kits', `${t.sample}.wav`)));
  eng.setSample(t.sample, w.channels[0]);
}
eng.setProject(p);
if (full) {
  eng.setMetering(true);
  eng.metronome = true;
  eng.perf.fx = 1; eng.perf.on = true; eng.perf.x = 0.9; // a beat repeat held down the whole time
}

const l = new Float32Array(128), r = new Float32Array(128);
const blocks = Math.floor((SR * SECONDS) / 128);
const budgetMs = (128 / SR) * 1000;
const times = new Float64Array(blocks);
let steps = 0;
eng.onStep = () => steps++;
eng.play();
for (let i = 0; i < 2000; i++) eng.process(l, r, 128); // warm up the JIT
steps = 0;
const t0 = performance.now();
for (let b = 0; b < blocks; b++) {
  const s = performance.now();
  eng.process(l, r, 128);
  times[b] = performance.now() - s;
}
const total = performance.now() - t0;
times.sort();
const pct = (q: number) => times[Math.min(blocks - 1, Math.floor(blocks * q))];
const row = (name: string, ms: number) =>
  console.log(`  ${name.padEnd(8)} ${ms.toFixed(3).padStart(7)} ms   ${((ms / budgetMs) * 100).toFixed(1).padStart(5)}% of budget`);

console.log(`\nLoopwell engine stress test: a 16-bar song, 8 tracks with every step on, 6-note chords on\n5-voice unison wavetable synths, 5 insert effects per track, automation, all master FX`);
if (full) console.log('plus an 808, drum synths, four-hit rolls on every drum step, arpeggios, grooves, four groups with effects,\nloudness meters on every channel, the metronome and a performance effect');
console.log(`${SECONDS}s of audio at ${SR} Hz, ${blocks} blocks of 128 frames (budget ${budgetMs.toFixed(3)} ms each), ${steps} steps\n`);
row('median', pct(0.5));
row('p99', pct(0.99));
row('p99.9', pct(0.999));
row('worst', times[blocks - 1]);
console.log(`\n  ${(SECONDS * 1000 / total).toFixed(0)}x faster than real time\n`);
// The song is far heavier than anything a person would make. It has to fit with room to spare
// on a typical block, and even the slow blocks (which on a shared machine are mostly other
// programs getting in the way) must stay inside the budget.
if (pct(0.5) > budgetMs * 0.4 || pct(0.99) > budgetMs) {
  console.error('FAIL: the engine is too slow for real time');
  process.exit(1);
}
