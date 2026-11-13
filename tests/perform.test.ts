import { describe, expect, it } from 'vitest';
import { PerfFx } from '../src/core/dsp/perf';
import { Engine, LAUNCH_FOLLOW, LAUNCH_OFF } from '../src/core/engine';
import { launchesToClips, samplesToLane } from '../src/core/performance';
import { renderProject } from '../src/core/render';
import { emptyProject, newPattern, newTrack, type Project } from '../src/core/types';

const SR = 48000, SPS = 6000;

/** Two click tracks, hard left and hard right. Pattern A has hits on the left track's beats, pattern B on the off-beats. */
function twoTracks(): Project {
  const p = emptyProject();
  p.tracks = [newTrack('drum', 0, 'L', 'test/click'), newTrack('drum', 1, 'R', 'test/click')];
  p.tracks[0].pan = -64; p.tracks[1].pan = 63;
  p.patterns = p.patterns.map(() => newPattern(2));
  for (let s = 0; s < 16; s += 4) { p.patterns[0].steps[0][s] = 127; p.patterns[0].steps[1][s] = 127; }
  for (let s = 2; s < 16; s += 4) { p.patterns[1].steps[0][s] = 127; p.patterns[1].steps[1][s] = 127; }
  p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
  return p;
}
const click = () => { const f = new Float32Array(64); f[0] = 1; return f; };
const hitSteps = (buf: Float32Array) => {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > 0.05 && (i === 0 || Math.abs(buf[i - 1]) <= 0.05)) out.push(i / SPS);
  return out;
};
function engine(p = twoTracks()): Engine {
  const e = new Engine(SR);
  e.setSample('test/click', click());
  e.setProject(p);
  return e;
}
function run(e: Engine, steps: number, at: Record<number, () => void> = {}): [Float32Array, Float32Array] {
  const l = new Float32Array(steps * SPS), r = new Float32Array(steps * SPS);
  for (let s = 0; s < steps; s++) {
    at[s]?.();
    for (let k = 0; k < SPS; k += 500) e.process(l, r, 500, s * SPS + k);
  }
  return [l, r];
}

describe('clip launcher', () => {
  it('lets each track loop its own pattern', () => {
    const e = engine();
    e.launchClip(1, 1, 0);
    e.play();
    const [l, r] = run(e, 16);
    expect(hitSteps(l)).toEqual([0, 4, 8, 12]);
    expect(hitSteps(r)).toEqual([2, 6, 10, 14]);
  });

  it('brings a launch in on the next bar, beat or step', () => {
    for (const [quant, first] of [[16, 18], [4, 6], [1, 6]] as const) {
      const e = engine();
      e.play();
      // asked for in the middle of step 3: pattern B's hits are on 2, 6, 10, 14 of each bar
      const [, r] = run(e, 32, { 3: () => e.launchClip(1, 1, quant) });
      const got = hitSteps(r);
      expect(got.filter((s) => s % 4 === 2)[0], `quant ${quant}`).toBe(first);
      // the old clip plays right up to the line and not after it
      const line = quant === 16 ? 16 : 4;
      expect(got.filter((s) => s % 4 === 0).every((s) => s < line || quant === 1)).toBe(true);
    }
  });

  it('launches at once when asked to, and when stopped', () => {
    const e = engine();
    e.play();
    const [, r] = run(e, 16, { 5: () => e.launchClip(1, 1, 0) });
    expect(hitSteps(r)).toEqual([0, 4, 6, 10, 14]);
    const stopped = engine();
    stopped.launchClip(0, 1, 16);
    expect(stopped.launch[0]).toBe(1);
  });

  it('stops a track on the line and lets it follow again', () => {
    const e = engine();
    e.play();
    const [l, r] = run(e, 48, { 2: () => e.launchClip(0, LAUNCH_OFF, 16), 20: () => e.launchClip(0, LAUNCH_FOLLOW, 16) });
    expect(hitSteps(l)).toEqual([0, 4, 8, 12, 32, 36, 40, 44]);
    expect(hitSteps(r).length).toBe(12);
  });

  it('reports what every track is playing, with the step it changed on', () => {
    const e = engine();
    const seen: string[] = [];
    e.onLaunch = (tracks, count) => seen.push(`${count}:${[...tracks.slice(0, 2)]}`);
    e.play();
    run(e, 40, { 3: () => e.launchClip(1, 1, 16), 18: () => e.setPattern(1), 33: () => e.launchClip(0, LAUNCH_OFF, 4) });
    expect(seen).toEqual(['0:0,0', '16:0,1', '32:1,1', '36:-2,1']);
  });

  it('is never part of a render', async () => {
    const p = twoTracks();
    const a = await renderProject(p, { 'test/click': { l: click() } }, { sampleRate: SR, chain: [0], maxTail: 0.1 });
    expect(hitSteps(a.l.subarray(0, 16 * SPS))).toEqual([0, 4, 8, 12]);
  });
});

describe('recording a performance', () => {
  it('turns launches into clips that start in time and loop from the right step', () => {
    const log = [
      { at: 32, tracks: [0, 0] },
      { at: 48, tracks: [0, 1] },
      { at: 52, tracks: [2, 1] }, // launched on a beat, a quarter of the way into the bar
      { at: 64, tracks: [-2, 1] },
    ];
    const clips = launchesToClips(log, 32, 80, 16, 2).map((c) => [c.track, c.pattern, c.start, c.len, c.offset]);
    expect(clips).toEqual([
      [0, 0, 0, 20, 0], [0, 2, 20, 12, 4],
      [1, 0, 0, 16, 0], [1, 1, 16, 32, 0],
    ]);
  });

  it('starts on the bar line when recording starts mid-bar, and rounds the end up to a bar', () => {
    const clips = launchesToClips([{ at: 37, tracks: [3] }], 37, 50, 16, 1);
    expect(clips.map((c) => [c.start, c.len, c.offset])).toEqual([[0, 32, 0]]);
    expect(launchesToClips([{ at: 0, tracks: [-2, -2] }], 0, 64, 16, 2)).toEqual([]);
    expect(launchesToClips([], 0, 64, 16, 2)).toEqual([]);
  });

  it('plays back exactly what was performed', () => {
    // perform: track R switches to pattern B at bar 2, track L stops at bar 3
    const live = engine();
    const log: { at: number; tracks: number[] }[] = [];
    live.onLaunch = (tracks, at) => log.push({ at, tracks: [...tracks.slice(0, 2)] });
    live.play();
    const [l1, r1] = run(live, 48, { 10: () => live.launchClip(1, 1, 16), 30: () => live.launchClip(0, LAUNCH_OFF, 16) });
    // play the recording back from the timeline
    const p = twoTracks();
    p.arr.clips = launchesToClips(log, 0, 48, 16, 2);
    p.songMode = true;
    const song = engine(p);
    song.play();
    const [l2, r2] = run(song, 48);
    expect(hitSteps(l2)).toEqual(hitSteps(l1));
    expect(hitSteps(r2)).toEqual(hitSteps(r1));
  });

  it('turns a sweep into a lane with no more points than it needs', () => {
    const samples = [0, 0, 0, 0, -10, -30, -30, -30, -30, 0, 0, 0].map((v, i) => ({ t: 16 + i, v }));
    const lane = samplesToLane(samples, -1, 'mfilter', 16, 0)!;
    expect(lane.points).toEqual([{ t: 0, v: 0 }, { t: 3, v: 0 }, { t: 4, v: -10 }, { t: 5, v: -30 }, { t: 8, v: -30 }, { t: 9, v: 0 }, { t: 11, v: 0 }]);
    expect(samplesToLane(samples.map((s) => ({ ...s, v: 5 })), -1, 'mfilter', 16, 5)).toBeNull();
    expect(samplesToLane([], -1, 'mfilter', 0, 0)).toBeNull();
  });
});

describe('performance effects', () => {
  const tone = (n: number, f = 220) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR) * 0.5);
  const rms = (b: Float32Array, from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += b[i] * b[i]; return Math.sqrt(s / (to - from)); };
  function through(fx: PerfFx, input: Float32Array, at: Record<number, () => void> = {}): Float32Array {
    const out = new Float32Array(input.length), r = new Float32Array(input.length);
    for (let pos = 0; pos < input.length; pos += 128) {
      at[pos]?.();
      const l = input.slice(pos, pos + 128), rr = input.slice(pos, pos + 128);
      fx.process(l, rr, l.length, SPS);
      out.set(l, pos); r.set(rr, pos);
    }
    return out;
  }
  const maxJump = (b: Float32Array) => { let m = 0; for (let i = 1; i < b.length; i++) m = Math.max(m, Math.abs(b[i] - b[i - 1])); return m; };

  it('does nothing at all until it is engaged', () => {
    const fx = new PerfFx(SR);
    const x = tone(SR);
    expect(through(fx, x)).toEqual(x);
  });

  it('filter: sweeps down on the left and comes back clean', () => {
    const fx = new PerfFx(SR);
    const x = tone(SR * 2, 4000);
    const out = through(fx, x, { [128 * 100]: () => { fx.fx = 0; fx.on = true; fx.x = 0.05; fx.y = 0.2; }, [128 * 400]: () => { fx.on = false; } });
    expect(rms(out, SR * 0.6, SR * 0.9)).toBeLessThan(rms(x, SR * 0.6, SR * 0.9) * 0.1);
    expect(rms(out, SR * 1.7, SR * 1.9)).toBeCloseTo(rms(x, SR * 1.7, SR * 1.9), 2);
  });

  it('repeat: loops the slice that had just played, in time, until it is let go', () => {
    const fx = new PerfFx(SR);
    // a ramp makes every sample recognisable
    const x = Float32Array.from({ length: SR * 2 }, (_, i) => ((i % 48000) / 48000) * 0.8);
    const on = 128 * 150, off = 128 * 450;
    const out = through(fx, x, { [on]: () => { fx.fx = 1; fx.on = true; fx.x = 0.5; fx.y = 1; }, [off]: () => { fx.on = false; } });
    // x = 0.5 is a 16th: the 6000 frames before the press, repeating
    for (const k of [1, 2, 3]) for (const i of [400, 3000, 5500]) expect(out[on + k * SPS + i]).toBeCloseTo(x[on - SPS + i], 5);
    expect(out[off + 4000]).toBeCloseTo(x[off + 4000], 5);
    expect(maxJump(out.subarray(off, off + 2000))).toBeLessThan(0.06);
  });

  it('repeat: gets quieter each time round when the pad is held low', () => {
    const fx = new PerfFx(SR);
    const x = tone(SR * 2);
    const on = 128 * 150;
    const out = through(fx, x, { [on]: () => { fx.fx = 1; fx.on = true; fx.x = 0.5; fx.y = 0; } });
    expect(rms(out, on + SPS * 5, on + SPS * 6)).toBeLessThan(rms(out, on + SPS, on + SPS * 2) * 0.2);
  });

  it('tape stop: winds down to silence, then snaps back in time without a click', () => {
    const fx = new PerfFx(SR);
    const x = tone(SR * 3, 440);
    const on = 128 * 200, off = 128 * 800;
    const out = through(fx, x, { [on]: () => { fx.fx = 2; fx.on = true; fx.x = 0; fx.y = 0.5; }, [off]: () => { fx.on = false; } });
    // pitch falls: fewer zero crossings in each successive stretch
    const crossings = (from: number, to: number) => { let n = 0; for (let i = from + 1; i < to; i++) if (out[i - 1] < 0 !== out[i] < 0) n++; return n; };
    expect(crossings(on + 2400, on + 4800)).toBeLessThan(crossings(on, on + 2400));
    expect(rms(out, on + SR * 0.3, off)).toBeLessThan(0.001);
    expect(out[off + 2000]).toBeCloseTo(x[off + 2000], 5);
    expect(maxJump(out)).toBeLessThan(0.05);
  });

  it('throw: sends the mix to the reverb while held and lets the tail ring after', () => {
    const run = (thrown: boolean) => {
      const p = emptyProject();
      p.tracks = [newTrack('drum', 0, 'C', 'test/click')];
      p.patterns = p.patterns.map(() => newPattern(1));
      p.patterns[0].steps[0][0] = 127;
      p.fx.compOn = false;
      const e = engine(p);
      if (thrown) { e.perf.fx = 3; e.perf.on = true; e.perf.x = 1; e.perf.y = 1; }
      const l = new Float32Array(SR), r = new Float32Array(SR);
      e.process(l, r, 512); // the send eases in, so let it arrive before the hit
      e.play();
      e.process(l, r, 2400);
      e.perf.on = false;
      e.stop();
      e.process(l, r, SR - 2400, 2400);
      return rms(l, SR * 0.3, SR * 0.9);
    };
    expect(run(false)).toBeLessThan(1e-6);
    expect(run(true)).toBeGreaterThan(1e-4);
  });
});
