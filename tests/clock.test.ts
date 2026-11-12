import { describe, expect, it } from 'vitest';
import { StepClock, samplesPerStep, swingOffset } from '../src/core/clock';

/** Run the clock in fixed-size blocks and collect the absolute frame of every step. */
function run(clock: StepClock, blocks: number, size = 128, onBlock?: (b: number) => void): number[] {
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    onBlock?.(b);
    const base = clock.pos;
    clock.advance(size, (_s, off) => out.push(base + off));
  }
  return out;
}

describe('StepClock', () => {
  it('fires the first step on frame 0', () => {
    const c = new StepClock(48000);
    expect(run(c, 1)[0]).toBe(0);
  });

  it('is exact when a step is a whole number of frames', () => {
    const c = new StepClock(48000); // 120 bpm -> 6000 frames per 16th
    const t = run(c, 4000);
    expect(t.length).toBeGreaterThan(80);
    t.forEach((f, i) => expect(f).toBe(i * 6000));
  });

  it.each([
    [44100, 133], [48000, 97], [48000, 174], [96000, 61], [44100, 240], [48000, 40],
  ])('never drifts more than half a frame at %i Hz / %i bpm', (sr, bpm) => {
    const c = new StepClock(sr);
    c.bpm = bpm;
    const sps = samplesPerStep(bpm, sr);
    const t = run(c, Math.ceil((20000 * sps) / 128));
    expect(t.length).toBeGreaterThanOrEqual(19999);
    let worst = 0;
    for (let i = 0; i < t.length; i++) worst = Math.max(worst, Math.abs(t[i] - i * sps));
    expect(worst).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('gives identical step frames for any block size', () => {
    const ref = (() => { const c = new StepClock(44100); c.bpm = 127; c.swing = 37; return run(c, 20000, 128); })();
    for (const size of [1, 64, 127, 256, 480, 4096]) {
      const c = new StepClock(44100);
      c.bpm = 127; c.swing = 37;
      const t = run(c, Math.ceil((20000 * 128) / size), size);
      const n = Math.min(t.length, ref.length) - 1;
      expect(t.slice(0, n)).toEqual(ref.slice(0, n));
    }
  });

  it('fires each step exactly once, in order, inside its block', () => {
    const c = new StepClock(48000);
    c.bpm = 240;
    const seen: number[] = [];
    for (let b = 0; b < 5000; b++) {
      c.advance(128, (s, off) => {
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(128);
        seen.push(s);
      });
    }
    seen.forEach((s, i) => expect(s).toBe(i));
  });

  it('delays only the off-beat 16ths when swung', () => {
    const sr = 48000, sps = samplesPerStep(120, sr);
    const c = new StepClock(sr);
    c.swing = 100; // off-beats land 75% of the way through the 8th
    const t = run(c, 2000);
    for (let i = 0; i < t.length; i++) {
      expect(t[i]).toBe(Math.round(i * sps + (i % 2 ? sps * 0.5 : 0)));
    }
    expect(swingOffset(2, 60, sps)).toBe(0);
    expect(swingOffset(3, 50, sps)).toBeCloseTo(sps * 0.25);
  });

  it('follows tempo changes from the next step, without a jump', () => {
    const sr = 48000;
    const c = new StepClock(sr);
    const t = run(c, 3000, 128, (b) => { if (b === 1000) c.bpm = 90; });
    const change = 1000 * 128;
    for (let i = 1; i < t.length; i++) {
      const gap = t[i] - t[i - 1];
      if (t[i - 1] >= change) expect(gap).toBe(8000);
      else if (t[i] < change) expect(gap).toBe(6000);
      else expect(gap).toBe(6000); // the step already in flight keeps its length
    }
  });

  it('reports the frame of the upcoming step', () => {
    const c = new StepClock(44100);
    c.bpm = 100;
    for (let b = 0; b < 500; b++) {
      const next = c.nextFrame();
      const base = c.pos;
      let first = -1;
      c.advance(128, (_s, off) => { if (first < 0) first = base + off; });
      if (first >= 0) expect(first).toBe(Math.max(next, base));
    }
  });
});
