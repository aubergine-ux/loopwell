// Stress test for the audio engine: a deliberately brutal project (every step
// on, on every track, chords on both synths, all effects up) rendered one
// 128-frame block at a time, the way the AudioWorklet calls it.
// Reports how much of the real-time budget the worst block used.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/core/engine';
import { stressProject } from '../tests/realtime/stress';
import { decodeWav } from '../src/core/wav';

const SR = 48000;
const SECONDS = 60;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const eng = new Engine(SR);
const p = stressProject();
for (const t of p.tracks) {
  if (t.kind !== 'drum') continue;
  const w = decodeWav(readFileSync(join(root, 'public/kits', `${t.sample}.wav`)));
  eng.setSample(t.sample, w.channels[0]);
}
eng.setProject(p);

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

console.log(`\nLoopwell engine stress test: 8 tracks, 32 steps all on, 6-note chords, all FX`);
console.log(`${SECONDS}s of audio at ${SR} Hz, ${blocks} blocks of 128 frames (budget ${budgetMs.toFixed(3)} ms each), ${steps} steps\n`);
row('median', pct(0.5));
row('p99', pct(0.99));
row('p99.9', pct(0.999));
row('worst', times[blocks - 1]);
console.log(`\n  ${(SECONDS * 1000 / total).toFixed(0)}x faster than real time\n`);
if (pct(0.999) > budgetMs * 0.5) {
  console.error('FAIL: engine uses more than half the real-time budget');
  process.exit(1);
}
