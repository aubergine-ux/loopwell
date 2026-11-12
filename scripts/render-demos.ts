// Bounces every demo beat to a WAV file. Handy for listening to engine changes.
// Usage: npx tsx scripts/render-demos.ts [outDir]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMOS } from '../src/core/demos';
import { ALL_SAMPLES } from '../src/core/kits';
import { renderProject, type SampleBank } from '../src/core/render';
import { decodeWav, encodeWav } from '../src/core/wav';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'renders');
mkdirSync(out, { recursive: true });

const bank: SampleBank = {};
for (const id of ALL_SAMPLES) bank[id] = { l: decodeWav(readFileSync(join(root, 'public/kits', `${id}.wav`))).channels[0] };

for (const d of DEMOS) {
  const p = d.make();
  const t0 = performance.now();
  const r = await renderProject(p, bank, { sampleRate: 44100, chain: p.songMode ? p.song : [0, 0] });
  let peak = 0, sum = 0;
  for (let i = 0; i < r.l.length; i++) { peak = Math.max(peak, Math.abs(r.l[i]), Math.abs(r.r[i])); sum += r.l[i] * r.l[i] + r.r[i] * r.r[i]; }
  const rms = Math.sqrt(sum / (2 * r.l.length));
  writeFileSync(join(out, `${d.id}.wav`), encodeWav([r.l, r.r], 44100, 16));
  console.log(`${d.id.padEnd(12)} ${(r.l.length / 44100).toFixed(1)}s  peak ${(20 * Math.log10(peak)).toFixed(1)} dB  rms ${(20 * Math.log10(rms)).toFixed(1)} dB  (${(performance.now() - t0).toFixed(0)} ms)`);
}
