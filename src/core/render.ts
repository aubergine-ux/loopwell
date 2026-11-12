// Offline bounce: runs the same Engine as the worklet, faster than real time.

import { songEnd, stepToSeconds } from './arrange';
import { samplesPerStep } from './clock';
import { Engine } from './engine';
import type { Project } from './types';

export interface SampleBank {
  [id: string]: { l: Float32Array; r?: Float32Array };
}

export interface RenderOptions {
  sampleRate: number;
  /** Patterns to play in order. Leave out to render the timeline. */
  chain?: number[];
  /** Render only this track, without the master compressor. */
  stem?: number;
  /** Longest reverb/delay tail to keep after the last step, seconds. */
  maxTail?: number;
  /** Called every ~1s of rendered audio; await it to keep a UI alive. */
  onProgress?: (done: number) => void | Promise<void>;
}

export interface Rendered {
  l: Float32Array;
  r: Float32Array;
  sampleRate: number;
}

export async function renderProject(project: Project, bank: SampleBank, opts: RenderOptions): Promise<Rendered> {
  const sr = opts.sampleRate;
  const eng = new Engine(sr);
  for (const id in bank) eng.setSample(id, bank[id].l, bank[id].r);
  eng.setProject(project);
  eng.stem = opts.stem ?? -1;

  const body = opts.chain
    ? Math.ceil(opts.chain.length * project.steps * samplesPerStep(project.bpm, sr))
    : Math.ceil(stepToSeconds(project, songEnd(project.arr) || project.steps) * sr);
  const maxTail = Math.round((opts.maxTail ?? 8) * sr);
  const total = body + maxTail;
  const l = new Float32Array(total), r = new Float32Array(total);

  const CHUNK = 128 * 64;
  const quietFrames = Math.round(sr * 0.25);
  let pos = 0, quiet = 0, sinceYield = 0;
  if (opts.chain) eng.play({ chain: opts.chain, loop: false });
  else {
    eng.setProject({ ...project, songMode: true });
    eng.play({ loop: false, from: 0 });
  }
  while (pos < total) {
    const n = Math.min(CHUNK, total - pos);
    eng.process(l, r, n, pos);
    if (eng.ended) {
      let peak = 0;
      for (let i = pos; i < pos + n; i++) {
        const a = Math.abs(l[i]), b = Math.abs(r[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      quiet = peak < 1e-4 ? quiet + n : 0;
    }
    pos += n;
    if (quiet >= quietFrames) break;
    sinceYield += n;
    if (opts.onProgress && sinceYield >= sr) {
      sinceYield = 0;
      await opts.onProgress(Math.min(1, pos / body));
    }
  }
  const end = Math.max(body, pos - quiet + Math.round(sr * 0.05));
  return { l: l.slice(0, Math.min(end, total)), r: r.slice(0, Math.min(end, total)), sampleRate: sr };
}
