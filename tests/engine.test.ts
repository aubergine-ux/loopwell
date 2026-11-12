import { describe, expect, it } from 'vitest';
import { samplesPerStep } from '../src/core/clock';
import { Engine } from '../src/core/engine';
import { renderProject } from '../src/core/render';
import { emptyProject, newPattern, newTrack, type Project, synth } from '../src/core/types';

const SR = 48000;

/** A project with one dry, unprocessed track playing a single-sample impulse. */
function clickProject(bpm = 120): Project {
  const p = emptyProject();
  p.bpm = bpm;
  p.tracks = [newTrack('drum', 0, 'CLICK', 'test/click')];
  p.patterns = p.patterns.map(() => newPattern(1));
  p.fx.compOn = false;
  p.fx.revLevel = 0;
  p.fx.dlyLevel = 0;
  return p;
}

// An impulse with some silence after it, so the end-of-sample fade stays out of the way.
const click = () => { const f = new Float32Array(256); f[0] = 1; return f; };

/** Frames where the signal jumps up from silence. */
function onsets(buf: Float32Array, thresh = 0.05): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > thresh && (i === 0 || Math.abs(buf[i - 1]) <= thresh)) out.push(i);
  return out;
}

function renderLive(eng: Engine, frames: number, block = 128): Float32Array {
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let pos = 0; pos < frames; pos += block) eng.process(l, r, Math.min(block, frames - pos), pos);
  return l;
}

describe('Engine timing', () => {
  it('puts every hit on its exact output frame', () => {
    for (const bpm of [120, 133, 87, 171]) {
      const p = clickProject(bpm);
      for (let s = 0; s < 16; s++) p.patterns[0].steps[0][s] = 127;
      const eng = new Engine(SR);
      eng.setSample('test/click', click());
      eng.setProject(p);
      eng.play();
      const sps = samplesPerStep(bpm, SR);
      const out = renderLive(eng, Math.floor(sps * 64));
      const got = onsets(out);
      expect(got.length).toBe(64);
      got.forEach((f, i) => expect(f).toBe(Math.round(i * sps)));
    }
  });

  it('renders identically whatever the host block size', () => {
    const make = () => {
      const p = clickProject(141);
      p.swing = 58;
      [0, 3, 6, 7, 10, 13].forEach((s) => (p.patterns[0].steps[0][s] = 90 + s));
      const eng = new Engine(SR);
      eng.setSample('test/click', click());
      eng.setProject(p);
      eng.play();
      return eng;
    };
    const a = renderLive(make(), 96000, 128);
    for (const block of [32, 100, 512, 4096]) {
      const b = renderLive(make(), 96000, block);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      expect(diff).toBe(0);
    }
  });

  it('applies swing to the off-beats only', () => {
    const p = clickProject(120);
    p.swing = 100;
    for (let s = 0; s < 16; s++) p.patterns[0].steps[0][s] = 127;
    const eng = new Engine(SR);
    eng.setSample('test/click', click());
    eng.setProject(p);
    eng.play();
    const got = onsets(renderLive(eng, 6000 * 16));
    expect(got).toEqual(Array.from({ length: 16 }, (_, i) => i * 6000 + (i % 2 ? 3000 : 0)));
  });

  it('scales hits by velocity', () => {
    const p = clickProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][4] = 64;
    const eng = new Engine(SR);
    eng.setSample('test/click', click());
    eng.setProject(p);
    eng.play();
    const out = renderLive(eng, 6000 * 8);
    expect(Math.abs(out[24000])).toBeLessThan(Math.abs(out[0]) * 0.5);
    expect(Math.abs(out[24000])).toBeGreaterThan(0.1);
  });
});

describe('Engine sequencing', () => {
  const steps = (eng: Engine, frames: number) => {
    const log: string[] = [];
    eng.onStep = (i) => log.push(`${'ABCDEFGH'[i.pattern]}${i.step}`);
    renderLive(eng, frames);
    return log;
  };

  it('loops a 16 or 32 step pattern', () => {
    const p = clickProject();
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play();
    expect(steps(eng, 6000 * 34).slice(14, 18)).toEqual(['A14', 'A15', 'A0', 'A1']);
    p.steps = 32;
    eng.play();
    expect(steps(eng, 6000 * 34).slice(30, 34)).toEqual(['A30', 'A31', 'A0', 'A1']);
  });

  it('follows an explicit chain and wraps', () => {
    const p = clickProject();
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play({ chain: [0, 2, 1] });
    const log = steps(eng, 6000 * 16 * 4);
    expect([log[0], log[16], log[32], log[48]]).toEqual(['A0', 'C0', 'B0', 'A0']);
  });

  it('queues a pattern change until the bar line', () => {
    const p = clickProject();
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play();
    const first = steps(eng, 6000 * 5);
    eng.setPattern(3);
    const rest = steps(eng, 6000 * 14);
    expect(first.at(-1)).toBe('A4');
    expect(rest.slice(0, 11).every((s) => s[0] === 'A')).toBe(true);
    expect(rest[11]).toBe('D0');
  });

  it('stops at the end of a non-looping chain', async () => {
    const p = clickProject();
    p.patterns[1].steps[0][15] = 127;
    const eng = new Engine(SR);
    eng.setSample('test/click', click());
    eng.setProject(p);
    eng.play({ chain: [0, 1], loop: false });
    const out = renderLive(eng, 6000 * 40);
    expect(eng.ended).toBe(true);
    expect(onsets(out)).toEqual([6000 * 31]);
  });

  it('plays synth notes for their length', () => {
    const p = clickProject();
    p.tracks = [newTrack('synth', 0, 'SYN')];
    p.tracks[0].synth = synth({ wave: 0, cutoff: 127, reso: 0, env: 0, attack: 0, decay: 0, sustain: 127, release: 0 });
    p.patterns[0].notes[0] = [{ s: 4, l: 2, p: 57, v: 127 }];
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play();
    const out = renderLive(eng, 6000 * 16);
    const rms = (a: number, b: number) => Math.sqrt(out.slice(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    expect(rms(0, 24000)).toBe(0);
    expect(rms(24500, 35000)).toBeGreaterThan(0.05);
    expect(rms(40000, 48000)).toBeLessThan(0.002);
  });

  it('mute and solo decide which tracks sound', () => {
    const run = (edit: (p: Project) => void) => {
      const p = clickProject();
      p.tracks.push(newTrack('drum', 1, 'B', 'test/click'));
      p.patterns[0] = newPattern(2);
      p.patterns[0].steps[0][0] = 127;
      p.patterns[0].steps[1][4] = 127;
      edit(p);
      const eng = new Engine(SR);
      eng.setSample('test/click', click());
      eng.setProject(p);
      eng.play();
      return onsets(renderLive(eng, 6000 * 8), 0.2);
    };
    expect(run(() => {})).toEqual([0, 24000]);
    expect(run((p) => (p.tracks[1].mute = true))).toEqual([0]);
    expect(run((p) => (p.tracks[1].solo = true))).toEqual([24000]);
    expect(run((p) => { p.tracks[0].solo = true; p.tracks[1].mute = true; })).toEqual([0]);
  });
});

describe('renderProject', () => {
  it('bounces a chain to the right length with a tail', async () => {
    const p = clickProject(120);
    p.patterns[0].steps[0][0] = 127;
    const r = await renderProject(p, { 'test/click': { l: click() } }, { sampleRate: SR, chain: [0, 0] });
    expect(r.l.length).toBeGreaterThanOrEqual(6000 * 32);
    expect(r.l.length).toBeLessThan(6000 * 32 + SR);
    expect(onsets(r.l)).toEqual([0, 96000]);
  });

  it('renders a single stem', async () => {
    const p = clickProject();
    p.tracks.push(newTrack('drum', 1, 'B', 'test/click'));
    p.patterns[0] = newPattern(2);
    p.patterns[0].steps[0][2] = 127;
    p.patterns[0].steps[1][6] = 127;
    const bank = { 'test/click': { l: click() } };
    const s1 = await renderProject(p, bank, { sampleRate: SR, chain: [0], stem: 1 });
    expect(onsets(s1.l)).toEqual([36000]);
  });
});
