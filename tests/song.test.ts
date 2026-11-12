import { describe, expect, it } from 'vitest';
import { barsUpTo, curveAt, isDefaultArrangement, placeClip, posLabel, songEnd, stepToSeconds, tempoAt, trackStepAt } from '../src/core/arrange';
import { Engine } from '../src/core/engine';
import { exportMidi } from '../src/core/midi';
import { renderProject } from '../src/core/render';
import { chainToClips, emptyProject, newPattern, newTrack, resolveOverlaps, sanitize, type Clip, type Project } from '../src/core/types';

const SR = 48000;
const STEP = 6000; // frames per step at 120 bpm
const click = () => { const f = new Float32Array(256); f[0] = 1; return f; };
const clip = (track: number, pattern: number, start: number, len: number, offset = 0): Clip => ({ id: `${track}-${start}`, track, pattern, start, len, offset });

/** Two dry click tracks and an empty timeline, in song mode. */
function songProject(): Project {
  const p = emptyProject();
  p.tracks = [newTrack('drum', 0, 'ONE', 'test/click'), newTrack('drum', 1, 'TWO', 'test/click')];
  p.patterns = p.patterns.map(() => newPattern(2));
  p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
  p.arr.clips = [];
  p.songMode = true;
  return p;
}

function engine(p: Project): Engine {
  const eng = new Engine(SR);
  eng.setSample('test/click', click());
  eng.setProject(p);
  return eng;
}

function run(eng: Engine, frames: number): Float32Array {
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let pos = 0; pos < frames; pos += 128) eng.process(l, r, Math.min(128, frames - pos), pos);
  return l;
}

function onsets(buf: Float32Array, thresh = 0.05): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > thresh && (i === 0 || Math.abs(buf[i - 1]) <= thresh)) out.push(i);
  return out;
}

function songSteps(eng: Engine, frames: number): number[] {
  const log: number[] = [];
  eng.onStep = (i) => log.push(i.song);
  run(eng, frames);
  return log;
}

describe('timeline playback', () => {
  it('plays each track from its own clips', () => {
    const p = songProject();
    p.patterns[0].steps[0][0] = 127; // pattern A, track 1: downbeat
    p.patterns[1].steps[1][2] = 127; // pattern B, track 2: step 3
    p.arr.clips = [clip(0, 0, 0, 16), clip(1, 1, 16, 16), clip(0, 0, 32, 16)];
    const eng = engine(p);
    eng.play({ loop: false });
    expect(onsets(run(eng, STEP * 50))).toEqual([0, STEP * 18, STEP * 32]);
    expect(eng.ended).toBe(true);
  });

  it('loops the pattern inside a long clip, honours its offset and stops at its end', () => {
    const p = songProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][4] = 127;
    p.arr.clips = [clip(0, 0, 0, 40), clip(0, 0, 48, 6, 2)];
    const eng = engine(p);
    eng.play({ loop: false });
    // first clip: steps 0 4 | 16 20 | 32 36, cut at 40. Second starts on pattern step 2, so its hit on 4 lands at 50.
    expect(onsets(run(eng, STEP * 60)).map((f) => f / STEP)).toEqual([0, 4, 16, 20, 32, 36, 50]);
  });

  it('cuts a synth note where its clip ends', () => {
    const p = songProject();
    p.tracks[0] = newTrack('synth', 0, 'SYN');
    p.tracks[0].synth = { wave: 0, cutoff: 127, reso: 0, env: 0, attack: 0, decay: 0, sustain: 127, release: 0 };
    p.patterns[0].notes[0] = [{ s: 0, l: 16, p: 57, v: 127 }];
    p.arr.clips = [clip(0, 0, 0, 4)];
    const eng = engine(p);
    eng.play({ loop: false });
    const out = run(eng, STEP * 12);
    const rms = (a: number, b: number) => Math.sqrt(out.slice(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    expect(rms(STEP, STEP * 3)).toBeGreaterThan(0.05);
    expect(rms(STEP * 5, STEP * 12)).toBeLessThan(0.002);
  });

  it('follows tempo changes to the exact frame', () => {
    const p = songProject();
    for (let s = 0; s < 16; s += 4) p.patterns[0].steps[0][s] = 127;
    p.arr.clips = [clip(0, 0, 0, 32)];
    p.arr.tempo = [{ at: 16, bpm: 60 }, { at: 24, bpm: 240 }];
    const eng = engine(p);
    eng.play({ loop: false });
    const got = onsets(run(eng, STEP * 80));
    // 120 bpm for 16 steps, 60 bpm (12000 a step) for 8, then 240 bpm (3000 a step)
    expect(got).toEqual([0, 24000, 48000, 72000, 96000, 96000 + 48000, 192000, 192000 + 12000]);
    expect(stepToSeconds(p, 32)).toBeCloseTo((96000 + 96000 + 24000) / SR, 9);
    expect(tempoAt(p, 15)).toBe(120);
    expect(tempoAt(p, 16)).toBe(60);
  });

  it('never drifts through a long song full of tempo changes', () => {
    const p = songProject();
    p.bpm = 133;
    p.patterns[0].steps[0].fill(127, 0, 16);
    p.arr.clips = [clip(0, 0, 0, 2000)];
    p.arr.tempo = Array.from({ length: 40 }, (_, i) => ({ at: 37 + i * 49, bpm: 61 + ((i * 53) % 170) }));
    const eng = engine(p);
    eng.play({ loop: false });
    const frames: number[] = [];
    let block = 0;
    eng.onStep = (i) => frames.push(block + i.offset);
    const l = new Float32Array(128), r = new Float32Array(128);
    for (; !eng.ended; block += 128) eng.process(l, r, 128);
    expect(frames.length).toBe(2000);
    for (const s of [1, 36, 37, 500, 1234, 1999]) expect(Math.abs(frames[s] - stepToSeconds(p, s) * SR)).toBeLessThanOrEqual(0.5);
  });

  it('wraps at the end of the song, or around the loop region', () => {
    const p = songProject();
    p.arr.clips = [clip(0, 0, 0, 12)];
    let eng = engine(p);
    eng.play();
    expect(songSteps(eng, STEP * 26).slice(10, 15)).toEqual([10, 11, 0, 1, 2]);
    p.arr.loopOn = true; p.arr.loopStart = 4; p.arr.loopEnd = 8;
    eng = engine(p);
    eng.play();
    expect(songSteps(eng, STEP * 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 4, 5]);
    // a bounce ignores the loop and plays to the end
    eng = engine(p);
    eng.play({ loop: false });
    expect(songSteps(eng, STEP * 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('starts from the cursor and jumps when asked', () => {
    const p = songProject();
    p.arr.clips = [clip(0, 0, 0, 64)];
    const eng = engine(p);
    eng.play({ from: 32 });
    expect(songSteps(eng, STEP * 3)).toEqual([32, 33, 34]);
    eng.seek(8);
    expect(songSteps(eng, STEP * 3)).toEqual([8, 9, 10]);
  });

  it('plays an empty timeline as one silent bar', () => {
    const eng = engine(songProject());
    eng.play({ loop: false });
    expect(songSteps(eng, STEP * 20).length).toBe(16);
    expect(eng.ended).toBe(true);
  });

  it('moves between pattern and song on the bar line without a gap', () => {
    const p = songProject();
    p.songMode = false;
    p.patterns[2].steps[0].fill(127, 0, 16); // pattern C loops in pattern view
    p.patterns[0].steps[1].fill(127, 0, 16); // the song plays pattern A on track 2
    p.arr.clips = [clip(1, 0, 0, 64)];
    const eng = engine(p);
    const log: string[] = [];
    eng.onStep = (i) => log.push(i.song < 0 ? `p${i.step}` : `s${i.song}`);
    eng.play({ pattern: 2 });
    const a = run(eng, STEP * 5);
    eng.setProject({ ...p, songMode: true });
    const b = run(eng, STEP * 20);
    eng.setProject({ ...p, songMode: false });
    const c = run(eng, STEP * 12);
    expect(log.slice(0, 18)).toEqual([...Array.from({ length: 16 }, (_, i) => `p${i}`), 's0', 's1']);
    // 25 steps in, the song is on step 9: it finishes the bar, then pattern C takes over from its top
    expect(log.slice(25, 34)).toEqual(['s9', 's10', 's11', 's12', 's13', 's14', 's15', 'p0', 'p1']);
    // a hit on every single step throughout: nothing dropped or doubled at either switch
    const all = new Float32Array(STEP * 37);
    all.set(a); all.set(b, a.length); all.set(c, a.length + b.length);
    expect(onsets(all)).toEqual(Array.from({ length: 37 }, (_, i) => i * STEP));
  });

  it('keeps swing on the off-beats when bars have an odd number of steps', () => {
    const p = songProject();
    p.swing = 100;
    p.patterns[0].steps[0].fill(127, 0, 16);
    p.arr.clips = [clip(0, 0, 0, 10)];
    p.arr.sigs = [{ at: 0, num: 5, den: 16 }]; // five steps to the bar
    const eng = engine(p);
    eng.play({ loop: false });
    const got = onsets(run(eng, STEP * 14)).map((f) => f / STEP);
    expect(got).toEqual([0, 1.5, 2, 3.5, 4, 5, 6.5, 7, 8.5, 9]);
  });
});

describe('automation', () => {
  const peaks = (out: Float32Array, n: number) => Array.from({ length: n }, (_, i) => Math.abs(out[i * STEP]));

  it('moves a track knob along its curve while the song plays', () => {
    const p = songProject();
    p.patterns[0].steps[0].fill(127, 0, 16);
    p.arr.clips = [clip(0, 0, 0, 16)];
    p.arr.lanes = [{ id: 'a', track: 0, param: 'vol', on: true, points: [{ t: 0, v: 0 }, { t: 8, v: 100 }, { t: 12, v: 100 }, { t: 16, v: 50 }] }];
    const eng = engine(p);
    eng.play({ loop: false });
    const got = peaks(run(eng, STEP * 17), 16);
    expect(got[0]).toBeLessThan(0.01);
    for (let i = 1; i <= 8; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
    expect(got[8]).toBeCloseTo(got[11], 2);
    expect(got[15]).toBeLessThan(got[11] * 0.5);
    // the curve is level^2: step 4 sits at level 50, a quarter of full gain
    expect(got[4] / got[8]).toBeCloseTo(0.25, 1);
  });

  it('leaves the knob where the project has it once the song stops, and ignores lanes that are off', () => {
    const p = songProject();
    p.patterns[0].steps[0][0] = 127;
    p.arr.clips = [clip(0, 0, 0, 16)];
    p.arr.lanes = [{ id: 'a', track: 0, param: 'vol', on: true, points: [{ t: 0, v: 0 }] }];
    const eng = engine(p);
    eng.play();
    expect(Math.max(...run(eng, STEP * 4).map(Math.abs))).toBeLessThan(0.001);
    eng.stop();
    run(eng, 2048);
    eng.trigger(0, 127);
    expect(Math.max(...run(eng, 2048).map(Math.abs))).toBeGreaterThan(0.9);

    p.arr.lanes[0].on = false;
    const eng2 = engine(p);
    eng2.play();
    expect(Math.abs(run(eng2, STEP)[0])).toBeGreaterThan(0.9);
  });

  it('automates master and synth knobs too', () => {
    const p = songProject();
    p.patterns[0].steps[0].fill(127, 0, 16);
    p.arr.clips = [clip(0, 0, 0, 16)];
    p.arr.lanes = [{ id: 'm', track: -1, param: 'master', on: true, points: [{ t: 0, v: 100 }, { t: 8, v: 0 }] }];
    let eng = engine(p);
    eng.play({ loop: false });
    const got = peaks(run(eng, STEP * 16), 12);
    expect(got[0]).toBeGreaterThan(0.9);
    expect(got[10]).toBeLessThan(0.001);

    // a filter sweep on a synth: the same note is much brighter with the cutoff automated open
    p.tracks[0] = newTrack('synth', 0, 'SYN');
    p.tracks[0].synth = { wave: 0, cutoff: 10, reso: 0, env: 0, attack: 0, decay: 0, sustain: 127, release: 0 };
    p.patterns[0].notes[0] = [{ s: 0, l: 16, p: 45, v: 127 }];
    p.arr.lanes = [];
    const energy = (o: Float32Array) => o.slice(STEP * 8, STEP * 12).reduce((s, x) => s + x * x, 0);
    eng = engine(p);
    eng.play({ loop: false });
    const dark = energy(run(eng, STEP * 12));
    p.arr.lanes = [{ id: 'c', track: 0, param: 'cutoff', on: true, points: [{ t: 0, v: 10 }, { t: 6, v: 127 }] }];
    eng = engine(p);
    eng.play({ loop: false });
    expect(energy(run(eng, STEP * 12))).toBeGreaterThan(dark * 5);
  });

  it('reads a curve between and beyond its points', () => {
    const pts = [{ t: 4, v: 10 }, { t: 8, v: 30 }, { t: 8.5, v: 0 }];
    expect(curveAt(pts, 0)).toBe(10);
    expect(curveAt(pts, 6)).toBe(20);
    expect(curveAt(pts, 8)).toBe(30);
    expect(curveAt(pts, 99)).toBe(0);
  });
});

describe('arranging', () => {
  it('trims, splits and replaces what a new clip lands on', () => {
    const lay = (clips: Clip[]) => resolveOverlaps(clips, 16).map((c) => [c.start, c.len, c.offset]).sort((a, b) => a[0] - b[0]);
    expect(lay([clip(0, 0, 0, 16), clip(0, 1, 8, 16)])).toEqual([[0, 8, 0], [8, 16, 0]]); // tail trimmed
    expect(lay([clip(0, 0, 8, 16), clip(0, 1, 0, 12)])).toEqual([[0, 12, 0], [12, 12, 4]]); // head trimmed, offset keeps it in place
    expect(lay([clip(0, 0, 0, 32), clip(0, 1, 8, 8)])).toEqual([[0, 8, 0], [8, 8, 0], [16, 16, 0]]); // split around it
    expect(lay([clip(0, 0, 4, 4), clip(0, 1, 0, 16)])).toEqual([[0, 16, 0]]); // swallowed
    expect(lay([clip(0, 0, 0, 16), clip(1, 1, 8, 16)])).toEqual([[0, 16, 0], [8, 16, 0]]); // other tracks don't care

    const p = songProject();
    p.arr.clips = [clip(0, 0, 0, 16)];
    placeClip(p.arr, clip(0, 2, 8, 8), 16);
    expect(trackStepAt(p, 0, 7)!.pattern).toBe(0);
    expect(trackStepAt(p, 0, 9)).toMatchObject({ pattern: 2, local: 1 });
    expect(trackStepAt(p, 0, 16)).toBeNull();
    expect(songEnd(p.arr)).toBe(16);
  });

  it('merges a repeated pattern into one clip per track', () => {
    const clips = chainToClips([0, 0, 1, 0], 2, 16);
    expect(clips.filter((c) => c.track === 1).map((c) => [c.pattern, c.start, c.len])).toEqual([[0, 0, 32], [1, 32, 16], [0, 48, 16]]);
  });

  it('counts bars through time-signature changes', () => {
    const p = songProject();
    p.arr.sigs = [{ at: 32, num: 3, den: 4 }, { at: 60, num: 7, den: 8 }];
    const bars = barsUpTo(p, 100).map((b) => [b.start, b.len]);
    // two bars of 4/4, then 3/4 from bar 3; the 7/8 change at step 60 waits for the next bar line (68)
    expect(bars.slice(0, 7)).toEqual([[0, 16], [16, 16], [32, 12], [44, 12], [56, 12], [68, 14], [82, 14]]);
    expect(posLabel(p, 0)).toBe('1.1.1');
    expect(posLabel(p, 37)).toBe('3.2.2');
    expect(posLabel(p, 68 + 3)).toBe('6.2.2'); // eighth-note beats in 7/8
  });

  it('knows an untouched timeline from an arranged one', () => {
    const p = emptyProject();
    expect(isDefaultArrangement(p)).toBe(true);
    p.arr.clips[3].len = 32;
    expect(isDefaultArrangement(p)).toBe(false);
  });

  it('cleans up a broken timeline', () => {
    const raw: any = emptyProject();
    raw.arr = {
      clips: [{ track: 0, pattern: 99, start: -5, len: 4 }, { track: 42, start: 0 }, { track: 1, pattern: 1, start: 0, len: 1e9 }, { track: 1, pattern: 2, start: 8, len: 8 }, 'x'],
      lanes: [{ track: 0, param: 'nope', points: [] }, { track: -1, param: 'vol' }, { track: 0, param: 'vol', points: [{ t: 9, v: 999 }, { t: 2, v: -3 }, { t: 9, v: 1 }, {}] }],
      tempo: [{ at: 0, bpm: 90 }, { at: 16, bpm: 9999 }, { at: 16, bpm: 100 }], sigs: [{ at: 4, num: 0, den: 3 }], markers: [{ at: 8 }, { at: 'x' }],
      loopOn: true, loopStart: 40, loopEnd: 8,
    };
    const p = sanitize(raw);
    // out-of-range numbers are pulled into range, and no two clips on a track overlap
    for (const c of p.arr.clips) {
      expect(c.track < 8 && c.pattern < 8 && c.start >= 0 && c.len >= 1 && c.start + c.len <= 8192 && c.offset < 16).toBe(true);
      for (const o of p.arr.clips) if (o !== c && o.track === c.track) expect(o.start >= c.start + c.len || o.start + o.len <= c.start).toBe(true);
    }
    expect(p.arr.clips.filter((c) => c.track === 1).map((c) => [c.pattern, c.start, c.len]).sort((x, y) => x[1] - y[1])).toEqual([[1, 0, 8], [2, 8, 8], [1, 16, 8176]]);
    expect(p.arr.lanes).toHaveLength(1);
    expect(p.arr.lanes[0].points).toEqual([{ t: 2, v: 0 }, { t: 9, v: 127 }]);
    expect(p.arr.tempo).toEqual([{ at: 16, bpm: 240 }]);
    expect(p.arr.sigs).toEqual([{ at: 4, num: 1, den: 4 }]);
    expect(p.arr.markers).toEqual([{ at: 8, name: 'marker', color: 0 }]);
    expect(p.arr.loopOn).toBe(false);
    expect(sanitize(p)).toEqual(p);
  });
});

describe('song export', () => {
  it('bounces the whole timeline, tempo changes included', async () => {
    const p = songProject();
    p.songMode = false; // what the app is showing doesn't matter to a timeline bounce
    p.patterns[0].steps[0][0] = 127;
    p.arr.clips = [clip(0, 0, 0, 16), clip(0, 0, 16, 16)];
    p.arr.tempo = [{ at: 16, bpm: 60 }];
    p.arr.loopOn = true; p.arr.loopEnd = 8;
    const r = await renderProject(p, { 'test/click': { l: click() } }, { sampleRate: SR });
    expect(onsets(r.l)).toEqual([0, 96000]);
    expect(r.l.length).toBeGreaterThanOrEqual(96000 + 192000);
    expect(r.l.length).toBeLessThan(96000 + 192000 + SR);
  });

  it('writes tempo, time signature and marker events into the MIDI file', () => {
    const p = songProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][3] = 90;
    p.swing = 100;
    p.arr.clips = [clip(0, 0, 0, 16), clip(0, 0, 20, 8, 2)];
    p.arr.tempo = [{ at: 16, bpm: 90 }];
    p.arr.sigs = [{ at: 16, num: 3, den: 4 }];
    p.arr.markers = [{ at: 16, name: 'hook', color: 1 }];
    const b = exportMidi(p);
    const text = String.fromCharCode(...b);
    expect(text).toContain('hook');
    // meta events in the conductor track: tempo x2, signatures 4/4 then 3/4
    const metas: number[][] = [];
    for (let i = 22; i < b.length - 6; i++) {
      if (b[i] === 0xff && b[i + 1] === 0x51 && b[i + 2] === 3) metas.push([0x51, (b[i + 3] << 16) | (b[i + 4] << 8) | b[i + 5]]);
      if (b[i] === 0xff && b[i + 1] === 0x58 && b[i + 2] === 4) metas.push([0x58, b[i + 3], 1 << b[i + 4]]);
    }
    expect(metas).toEqual([[0x51, 500000], [0x58, 4, 4], [0x51, 666667], [0x58, 3, 4]]);
    // note-ons: 0, swung 3, then the second clip starts on pattern step 2, so pattern step 3 is song step 21 (odd in its bar: swung)
    const ons: number[] = [];
    let tick = 0;
    const at = text.lastIndexOf('MTrk') + 8;
    for (let o = at; o < b.length - 3;) {
      let d = 0, c: number;
      do { c = b[o++]; d = (d << 7) | (c & 127); } while (c & 128);
      tick += d;
      if (b[o] === 0xff) { o += 3 + b[o + 2]; continue; }
      if ((b[o] & 0xf0) === 0x90) ons.push(tick);
      o += 3;
    }
    expect(ons).toEqual([0, 3 * 24 + 12, 21 * 24 + 12]);
  });
});
