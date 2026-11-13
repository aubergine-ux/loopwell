import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { renderProject } from '../src/core/render';
import { emptyProject, newPattern, newTrack, type Project } from '../src/core/types';

const SR = 48000, SPS = 6000;

function clicks(): Project {
  const p = emptyProject();
  p.tracks = [newTrack('drum', 0, 'C', 'test/click')];
  p.tracks[0].pan = -64; // the beat on the left only; the metronome is in the middle, so the right channel is all click
  p.patterns = p.patterns.map(() => newPattern(1));
  for (let s = 0; s < 16; s++) p.patterns[0].steps[0][s] = 100 + s; // each step a little louder, so it can be told apart
  p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
  return p;
}
const impulse = () => { const f = new Float32Array(64); f[0] = 1; return f; };
function engine(p = clicks()): Engine {
  const e = new Engine(SR);
  e.setSample('test/click', impulse());
  e.setProject(p);
  return e;
}
function run(e: Engine, steps: number, block = 128): [Float32Array, Float32Array] {
  const l = new Float32Array(steps * SPS), r = new Float32Array(steps * SPS);
  for (let pos = 0; pos < l.length; pos += block) e.process(l, r, Math.min(block, l.length - pos), pos);
  return [l, r];
}
/** Steps on which something starts in `buf` (after at least 20 ms of nothing). A click is a sine, so its very first sample is zero. */
function starts(buf: Float32Array): number[] {
  const out: number[] = [];
  let quiet = 99999;
  for (let i = 0; i < buf.length; i++) {
    if (Math.abs(buf[i]) > 0.01) { if (quiet > 960) out.push(Math.round(((i - 1) / SPS) * 1000) / 1000); quiet = 0; } else quiet++;
  }
  return out;
}
// how loud each step of the pattern comes out on the left when it simply plays
const REF = (() => { const e = engine(); e.play(); const l = run(e, 16)[0]; return Array.from({ length: 16 }, (_, s) => Math.abs(l[s * SPS])); })();
/** Which step of the pattern each hit on the left is (-1 for none), from how loud it is. */
const stepsHeard = (l: Float32Array, n: number) => Array.from({ length: n }, (_, k) => {
  const v = Math.abs(l[k * SPS]);
  return v < 0.01 ? -1 : REF.reduce((best, r, s) => (Math.abs(r - v) < Math.abs(REF[best] - v) ? s : best), 0);
});

describe('metronome', () => {
  it('clicks on every beat, with the first of the bar set apart', () => {
    const e = engine();
    e.metronome = true;
    e.play();
    const [, r] = run(e, 32);
    expect(starts(r)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    const level = (step: number) => Math.max(...r.subarray(step * SPS, step * SPS + 600).map(Math.abs));
    expect(level(0)).toBeGreaterThan(level(4) * 1.3);
    expect(level(16)).toBeCloseTo(level(0), 3);
    // higher pitch on the downbeat: more zero crossings in the same stretch
    const crossings = (step: number) => { let n = 0; for (let i = step * SPS + 1; i < step * SPS + 480; i++) if (r[i - 1] < 0 !== r[i] < 0) n++; return n; };
    expect(crossings(0)).toBeGreaterThan(crossings(4));
  });

  it('is off unless asked for, and never in a render', async () => {
    const e = engine();
    e.play();
    expect(starts(run(e, 16)[1])).toEqual([]);
    const out = await renderProject(clicks(), { 'test/click': { l: impulse() } }, { sampleRate: SR, chain: [0], maxTail: 0.1 });
    expect(Math.max(...out.r.map(Math.abs))).toBe(0);
  });

  it('follows the bar lines of the song, whatever the time signature', () => {
    const p = clicks();
    p.songMode = true;
    p.arr.sigs = [{ at: 0, num: 3, den: 4 }];
    p.arr.clips = [{ id: 'a', track: 0, pattern: 0, start: 0, len: 48, offset: 0 }];
    const e = engine(p);
    e.metronome = true;
    e.play({ loop: false });
    const [, r] = run(e, 24);
    const level = (step: number) => Math.max(...r.subarray(step * SPS, step * SPS + 600).map(Math.abs));
    expect(starts(r)).toEqual([0, 4, 8, 12, 16, 20]);
    expect([0, 12].every((s) => level(s) > level(4) * 1.3)).toBe(true); // a bar of 3/4 is 12 steps
  });

  it('lands on the exact frame, whatever the block size', () => {
    const a = (() => { const e = engine(); e.metronome = true; e.play(); return run(e, 16, 128)[1]; })();
    for (const block of [1, 97, 1024]) {
      const e = engine(); e.metronome = true; e.play();
      const b = run(e, 16, block)[1];
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      expect(diff).toBeLessThan(1e-6);
    }
  });
});

describe('count-in', () => {
  it('plays a bar of clicks, then starts the beat on time from its first step', () => {
    const e = engine();
    const seen: number[] = [];
    e.onStep = (i) => seen.push(i.count);
    e.play({ countIn: 16 });
    const [l, r] = run(e, 32);
    expect(starts(r)).toEqual([0, 4, 8, 12]); // metronome is off: clicks only while counting in
    expect(stepsHeard(l, 32)).toEqual([...new Array(16).fill(-1), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(seen.slice(0, 18)).toEqual([-16, -15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1]);
  });

  it('counts in for the song too, and a stop during it leaves nothing behind', () => {
    const p = clicks();
    p.songMode = true;
    const e = engine(p);
    e.play({ countIn: 32, from: 0 });
    const [l] = run(e, 40);
    expect(stepsHeard(l, 40).slice(30, 36)).toEqual([-1, -1, 0, 1, 2, 3]);
    const f = engine();
    f.play({ countIn: 16 });
    run(f, 6);
    f.stop();
    f.play();
    expect(stepsHeard(run(f, 4)[0], 4)).toEqual([0, 1, 2, 3]);
  });

  it('keeps swing on the right steps afterwards', () => {
    const p = clicks();
    p.swing = 100;
    const e = engine(p);
    e.play({ countIn: 16 });
    const [l] = run(e, 20);
    const first = Array.from(l).findIndex((v, i) => i >= 16 * SPS && Math.abs(v) > 0.01);
    const second = Array.from(l).findIndex((v, i) => i > first + 100 && Math.abs(v) > 0.01);
    expect(first).toBe(16 * SPS);
    expect(second).toBe(17 * SPS + SPS / 2);
  });
});

describe('loop region', () => {
  it('loops only the steps in the region', () => {
    const e = engine();
    e.setRange(4, 8);
    e.play();
    expect(stepsHeard(run(e, 10)[0], 10)).toEqual([4, 5, 6, 7, 4, 5, 6, 7, 4, 5]);
  });

  it('takes effect while playing and lets go again', () => {
    const e = engine();
    e.play();
    const l = new Float32Array(24 * SPS), r = new Float32Array(24 * SPS);
    e.process(l, r, 3 * SPS, 0);
    e.setRange(8, 10);
    e.process(l, r, 6 * SPS, 3 * SPS);
    e.setRange(0, 0);
    e.process(l, r, 15 * SPS, 9 * SPS);
    expect(stepsHeard(l, 24)).toEqual([0, 1, 2, 8, 9, 8, 9, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ignores a region the pattern does not reach, and never applies to a render', async () => {
    const e = engine();
    e.setRange(20, 28); // a 16-step pattern
    e.play();
    expect(stepsHeard(run(e, 4)[0], 4)).toEqual([0, 1, 2, 3]);
    const f = engine();
    f.setRange(4, 8);
    f.play({ chain: [0], loop: false });
    expect(stepsHeard(run(f, 16)[0], 16)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('counts each time round as a loop for step conditions', () => {
    const p = clicks();
    p.patterns[0].mods[0][5] = (2 << 5); // step 6 plays on the 2nd of every 2 loops
    const e = engine(p);
    e.setRange(4, 8);
    e.play();
    expect(stepsHeard(run(e, 12)[0], 12)).toEqual([4, -1, 6, 7, 4, 5, 6, 7, 4, -1, 6, 7]);
  });
});
