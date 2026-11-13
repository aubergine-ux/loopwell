import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chordPitches, scaleChords } from '../src/core/chords';
import { samplesPerStep } from '../src/core/clock';
import { CONDITIONS, arpIndex, condPass, euclid, makeMod, modChance, modCond, modLabel, modRatchet } from '../src/core/creative';
import { Engine } from '../src/core/engine';
import { decodeBeat, encodeBeat } from '../src/core/share';
import { emptyProject, newPattern, newTrack, sanitize, type Project } from '../src/core/types';
import { plain } from './helpers';

const SR = 48000;
const SPS = samplesPerStep(120, SR); // 6000

function clickProject(): Project {
  const p = emptyProject();
  p.tracks = [newTrack('drum', 0, 'CLICK', 'test/click')];
  p.patterns = p.patterns.map(() => newPattern(1));
  p.fx.compOn = false;
  p.fx.revLevel = 0;
  p.fx.dlyLevel = 0;
  return p;
}
const click = () => { const f = new Float32Array(64); f[0] = 1; return f; };

function onsets(buf: Float32Array, thresh = 0.02): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > thresh && (i === 0 || Math.abs(buf[i - 1]) <= thresh)) out.push(i);
  return out;
}

function run(p: Project, steps: number, setup?: (e: Engine) => void, block = 128): Float32Array {
  const eng = new Engine(SR);
  eng.setSample('test/click', click());
  eng.setProject(p);
  setup?.(eng);
  eng.play();
  const frames = Math.round(steps * SPS);
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let pos = 0; pos < frames; pos += block) eng.process(l, r, Math.min(block, frames - pos), pos);
  return l;
}
/** Which steps (counted from the start of playback) had a hit on them. */
const hitSteps = (buf: Float32Array) => onsets(buf).map((f) => f / SPS);

describe('Euclidean rhythms', () => {
  const str = (b: boolean[]) => b.map((x) => (x ? 'x' : '.')).join('');
  it('makes the classic patterns', () => {
    expect(str(euclid(8, 3))).toBe('x..x..x.');
    expect(str(euclid(8, 5))).toBe('x.x.xx.x'); // the cinquillo, turned
    expect(str(euclid(16, 4))).toBe('x...x...x...x...');
    expect(str(euclid(12, 0))).toBe('............');
    expect(str(euclid(5, 5))).toBe('xxxxx');
  });
  it('always has exactly the pulses asked for, as evenly spread as they can be', () => {
    for (let n = 1; n <= 32; n++) for (let k = 0; k <= n; k++) {
      const e = euclid(n, k);
      expect(e.filter(Boolean).length).toBe(k);
      if (!k) continue;
      const at = e.flatMap((x, i) => (x ? [i] : []));
      const gaps = at.map((a, i) => ((at[(i + 1) % at.length] - a + n - 1) % n) + 1);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    }
  });
  it('rotates, and survives silly input', () => {
    expect(str(euclid(8, 3, 1))).toBe('.x..x..x');
    expect(str(euclid(8, 3, -1))).toBe('..x..x.x');
    expect(str(euclid(8, 3, 8))).toBe(str(euclid(8, 3)));
    expect(euclid(0, 4).length).toBe(1);
    expect(euclid(4, 99).filter(Boolean).length).toBe(4);
  });
});

describe('step extras', () => {
  it('packs and unpacks', () => {
    for (let r = 1; r <= 4; r++) for (let c = 0; c < 8; c++) for (let k = 0; k < CONDITIONS.length; k++) {
      const m = makeMod(r, c, k);
      expect([modRatchet(m), modChance(m), modCond(m)]).toEqual([r, c, k]);
      expect(m).toBeLessThanOrEqual(511);
    }
    expect(makeMod(1, 0, 0)).toBe(0);
    expect(modLabel(0)).toBe('');
    expect(modLabel(makeMod(3, 4, 10))).toBe('50%, fill only, ×3');
  });

  it('knows which loops a condition plays on', () => {
    const loops = (cond: number, fill = false) => [0, 1, 2, 3, 4, 5, 6, 7].filter((l) => condPass(cond, l, fill));
    expect(loops(0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loops(2)).toEqual([1, 3, 5, 7]); // 2nd of 2
    expect(loops(5)).toEqual([2, 5]); // 3rd of 3
    expect(loops(9)).toEqual([3, 7]); // 4th of 4: "only every 4th loop"
    expect(loops(10)).toEqual([]);
    expect(loops(10, true).length).toBe(8);
    expect(loops(11, true)).toEqual([]);
    expect(loops(12)).toEqual([0]);
    expect(loops(13)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('plays a conditional step only on its loops', () => {
    const p = clickProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][8] = 127;
    p.patterns[0].mods[0][8] = makeMod(1, 0, 9); // 4th of 4
    expect(hitSteps(run(p, 16 * 8))).toEqual([0, 16, 32, 48, 56, 64, 80, 96, 112, 120]);
  });

  it('plays fill steps only while a fill is held', () => {
    const p = clickProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][4] = 127;
    p.patterns[0].mods[0][0] = makeMod(1, 0, 11); // not in fill
    p.patterns[0].mods[0][4] = makeMod(1, 0, 10); // fill only
    expect(hitSteps(run(p, 16))).toEqual([0]);
    expect(hitSteps(run(p, 16, (e) => { e.fill = true; }))).toEqual([4]);
  });

  it('follows the clip, not the song, when counting loops on the timeline', () => {
    const p = clickProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].mods[0][0] = makeMod(1, 0, 2); // 2nd of 2
    p.songMode = true;
    p.arr.clips = [{ id: 'a', track: 0, pattern: 0, start: 16, len: 64, offset: 0 }];
    expect(hitSteps(run(p, 80))).toEqual([32, 64]);
  });

  it('plays about the right share of steps for each chance, and the same ones every render', () => {
    const p = clickProject();
    for (let s = 0; s < 16; s++) { p.patterns[0].steps[0][s] = 127; p.patterns[0].mods[0][s] = makeMod(1, 4, 0); } // 50%
    const a = hitSteps(run(p, 16 * 40));
    expect(a.length).toBeGreaterThan(640 * 0.42);
    expect(a.length).toBeLessThan(640 * 0.58);
    expect(hitSteps(run(p, 16 * 40))).toEqual(a);
    expect(hitSteps(run(p, 16 * 40, undefined, 1000))).toEqual(a);
    // and it isn't the same steps every loop
    expect(new Set(a.slice(0, 40).map((s) => s % 16)).size).toBeGreaterThan(8);
  });

  it('spaces a ratchet evenly inside its step, to the sample', () => {
    for (const n of [2, 3, 4]) {
      const p = clickProject();
      p.patterns[0].steps[0][2] = 127;
      p.patterns[0].mods[0][2] = makeMod(n, 0, 0);
      const got = onsets(run(p, 16));
      expect(got).toEqual(Array.from({ length: n }, (_, k) => Math.round(2 * SPS + (k * SPS) / n)));
    }
  });

  it('renders ratchets and grooves identically whatever the block size', () => {
    const make = () => {
      const p = clickProject();
      p.swing = 40;
      p.groove = 5;
      p.grooveAmt = 80;
      [0, 3, 5, 6, 9, 10, 13, 15].forEach((s, i) => { p.patterns[0].steps[0][s] = 100; p.patterns[0].mods[0][s] = makeMod(1 + (i % 4), i % 3 ? 0 : 2, 0); });
      return p;
    };
    const a = run(make(), 64, undefined, 128);
    for (const block of [1, 37, 512, 4096]) {
      const b = run(make(), 64, undefined, block);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      expect(diff).toBe(0);
    }
  });

  it('a stop drops hits that were still waiting', () => {
    const p = clickProject();
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].mods[0][0] = makeMod(4, 0, 0);
    const eng = new Engine(SR);
    eng.setSample('test/click', click());
    eng.setProject(p);
    eng.play();
    const l = new Float32Array(12000), r = new Float32Array(12000);
    eng.process(l, r, 1000, 0);
    eng.stop();
    eng.process(l, r, 11000, 1000);
    expect(onsets(l)).toEqual([0]);
  });
});

describe('grooves', () => {
  const all = () => { const p = clickProject(); for (let s = 0; s < 16; s++) p.patterns[0].steps[0][s] = 127; return p; };

  it('leaves a beat alone when the amount is zero or the groove is Straight', () => {
    const straight = onsets(run(all(), 16));
    const p = all();
    p.groove = 1; p.grooveAmt = 0;
    expect(onsets(run(p, 16))).toEqual(straight);
  });

  it('MPC swing matches the swing knob at the same amount', () => {
    const a = all(); a.swing = 60;
    const b = all(); b.groove = 1; b.grooveAmt = 60;
    expect(onsets(run(b, 16))).toEqual(onsets(run(a, 16)));
  });

  it('shuffle moves the off-beat 8th onto the triplet', () => {
    const p = all(); p.groove = 2; p.grooveAmt = 100;
    const got = onsets(run(p, 4));
    expect(got[0]).toBe(0);
    expect(got[1]).toBe(SPS);
    expect(got[2]).toBe(Math.round(2.667 * SPS));
  });

  it('a track can have its own groove, and it wins over the song\'s', () => {
    const p = clickProject();
    p.tracks.push(newTrack('drum', 1, 'B', 'test/click'));
    p.patterns = p.patterns.map(() => newPattern(2));
    p.tracks[0].pan = -64; p.tracks[1].pan = 63;
    p.patterns[0].steps[0][1] = 127;
    p.patterns[0].steps[1][1] = 127;
    p.groove = 1; p.grooveAmt = 100; // song: half a step late
    p.tracks[1].groove = 1; p.tracks[1].grooveAmt = 50; // this track: a quarter
    const eng = new Engine(SR);
    eng.setSample('test/click', click());
    eng.setProject(p);
    eng.play();
    const l = new Float32Array(SPS * 4), r = new Float32Array(SPS * 4);
    eng.process(l, r, l.length);
    expect(onsets(l)).toEqual([SPS * 1.5]);
    expect(onsets(r)).toEqual([SPS * 1.25]);
  });

  it('humanize never moves a hit by more than its amount, and softens velocities', () => {
    const p = all(); p.groove = 4; p.grooveAmt = 100;
    const out = run(p, 16);
    const got = onsets(out);
    expect(got.length).toBe(16);
    got.forEach((f, i) => { expect(f).toBeGreaterThanOrEqual(i * SPS); expect(f).toBeLessThanOrEqual(i * SPS + 0.3 * SPS + 1); });
    expect(new Set(got.map((f, i) => f - i * SPS)).size).toBeGreaterThan(8);
    expect(new Set(got.map((f) => out[f].toFixed(3))).size).toBeGreaterThan(8);
  });
});

describe('arpeggiator', () => {
  /** Pitches a synth track starts, in order, with the frame each started on. */
  function arpRun(set: (p: Project) => void, steps = 16): [number, number][] {
    const p = emptyProject();
    p.tracks = [newTrack('synth', 0, 'S')];
    p.patterns = p.patterns.map(() => newPattern(1));
    p.patterns[0].notes[0] = [{ s: 0, l: 8, p: 60, v: 100 }, { s: 0, l: 8, p: 64, v: 100 }, { s: 0, l: 8, p: 67, v: 100 }];
    set(p);
    const eng = new Engine(SR);
    eng.setProject(p);
    const log: [number, number][] = [];
    let frame = 0;
    const on = eng.noteOn.bind(eng);
    eng.noteOn = (t, pitch, vel, gate) => { log.push([pitch, frame + (eng as any).from]); on(t, pitch, vel, gate); };
    eng.play();
    const l = new Float32Array(128), r = new Float32Array(128);
    for (; frame < steps * SPS; frame += 128) eng.process(l, r, 128);
    return log;
  }
  const pitches = (log: [number, number][]) => log.map((x) => x[0]);

  it('plays chords as written when it is off', () => {
    expect(pitches(arpRun(() => {}))).toEqual([60, 64, 67]);
  });
  it('walks up, down and back again for as long as the chord is held', () => {
    expect(pitches(arpRun((p) => { p.tracks[0].arpMode = 1; }))).toEqual([60, 64, 67, 60, 64, 67, 60, 64]);
    expect(pitches(arpRun((p) => { p.tracks[0].arpMode = 2; }))).toEqual([67, 64, 60, 67, 64, 60, 67, 64]);
    expect(pitches(arpRun((p) => { p.tracks[0].arpMode = 3; }))).toEqual([60, 64, 67, 64, 60, 64, 67, 64]);
  });
  it('climbs through extra octaves', () => {
    expect(pitches(arpRun((p) => { p.tracks[0].arpMode = 1; p.tracks[0].arpOct = 2; }))).toEqual([60, 64, 67, 72, 76, 79, 60, 64]);
  });
  it('keeps time at every rate, 32nds included', () => {
    for (const [rate, every] of [[0, 4], [1, 2], [2, 1], [3, 0.5]] as const) {
      const log = arpRun((p) => { p.tracks[0].arpMode = 1; p.tracks[0].arpRate = rate; });
      expect(log.length).toBe(8 / every);
      log.forEach(([, f], i) => expect(f).toBe(Math.round(i * every * SPS)));
    }
  });
  it('starts again when a new chord comes in', () => {
    const got = pitches(arpRun((p) => {
      p.tracks[0].arpMode = 1;
      p.patterns[0].notes[0] = [{ s: 0, l: 4, p: 60, v: 100 }, { s: 0, l: 4, p: 64, v: 100 }, { s: 4, l: 4, p: 62, v: 100 }, { s: 4, l: 4, p: 65, v: 100 }];
    }));
    expect(got).toEqual([60, 64, 60, 64, 62, 65, 62, 65]);
  });
  it('picks only held notes at random', () => {
    const got = pitches(arpRun((p) => { p.tracks[0].arpMode = 4; }));
    expect(got.length).toBe(8);
    expect(got.every((x) => [60, 64, 67].includes(x))).toBe(true);
    for (let i = 0; i < 50; i++) expect(arpIndex(4, i, 5, i / 50)).toBeLessThan(5);
  });
});

describe('chords in key', () => {
  it('names the chords of C major and A minor', () => {
    expect(scaleChords(0, 0).map((c) => c.name)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
    expect(scaleChords(0, 0).map((c) => c.numeral)).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii']);
    expect(scaleChords(9, 1).map((c) => c.name)).toEqual(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
    expect(scaleChords(0, 0, 4).map((c) => c.name)).toEqual(['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7♭5']);
  });
  it('only ever uses notes of the scale', () => {
    for (let type = 0; type < 9; type++) for (const size of [3, 4, 5]) for (const c of scaleChords(3, type, size)) {
      expect(c.tones.length).toBe(size);
      expect(c.name.length).toBeGreaterThan(0);
      for (const p of chordPitches(c, 3, 48)) expect(scaleChords(3, type, 1).some((x) => (x.tones[0] + 3) % 12 === p % 12)).toBe(true);
    }
    expect(scaleChords(0, 9)).toEqual([]); // chromatic
  });
  it('voices and inverts', () => {
    const c = scaleChords(0, 0)[0];
    expect(chordPitches(c, 0, 48)).toEqual([48, 52, 55]);
    expect(chordPitches(c, 0, 48, 1)).toEqual([52, 55, 60]);
    expect(chordPitches(c, 0, 48, 2)).toEqual([55, 60, 64]);
    expect(chordPitches(c, 0, 120).every((p) => p <= 127)).toBe(true);
  });
});

describe('file compatibility', () => {
  // the demo links from the 2.0 README: these must open, and must not grow or change when re-shared
  const V2_LINKS = [...readFileSync(new URL('./fixtures/links-2.0.txt', import.meta.url), 'utf8').matchAll(/^\S+$/gm)].map((m) => m[0]);
  it('opens 2.0 links to a beat with no extras, and re-shares them byte for byte', () => {
    expect(V2_LINKS.length).toBe(4);
    for (const link of V2_LINKS) {
      const p = decodeBeat(link)!;
      expect(p).not.toBeNull();
      expect(p.groove).toBe(0);
      expect(p.tracks.every((t) => t.arpMode === 0 && t.groove === 0)).toBe(true);
      expect(p.patterns.every((pat) => pat.mods.length === p.tracks.length && pat.mods.every((row) => row.length === 32 && row.every((m) => m === 0)))).toBe(true);
      expect(encodeBeat(p)).toBe(link);
    }
  });

  it('carries grooves, arpeggiators and step extras in a link', () => {
    const p = emptyProject();
    p.groove = 3; p.grooveAmt = 77;
    p.tracks[2].groove = 5; p.tracks[2].grooveAmt = 12;
    p.tracks[7].arpMode = 3; p.tracks[7].arpRate = 3; p.tracks[7].arpOct = 3; p.tracks[7].arpGate = 41;
    p.patterns[0].steps[3][5] = 90;
    p.patterns[0].mods[3][5] = makeMod(4, 7, 13);
    p.patterns[5].mods[0][31] = makeMod(2, 0, 0);
    p.patterns[5].steps[0][31] = 100;
    p.patterns[2].notes[6].push({ s: 3, l: 2, p: 40, v: 99 });
    p.patterns[2].mods[6][3] = makeMod(3, 2, 10);
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
  });

  it('adds nothing to a link that uses none of it', () => {
    const p = emptyProject();
    const before = encodeBeat(p).length;
    p.tracks[0].arpMode = 1;
    expect(encodeBeat(p).length).toBeGreaterThan(before);
    expect(encodeBeat(emptyProject()).length).toBe(before);
  });

  it('fills in the new settings when it opens a saved 2.0 project', () => {
    const old: any = JSON.parse(JSON.stringify(emptyProject()));
    delete old.groove; delete old.grooveAmt;
    for (const t of old.tracks) { delete t.groove; delete t.grooveAmt; delete t.arpMode; delete t.arpRate; delete t.arpOct; delete t.arpGate; }
    for (const pat of old.patterns) delete pat.mods;
    old.patterns[1].steps[0][3] = 99;
    const p = sanitize(old);
    const want = emptyProject();
    want.patterns[1].steps[0][3] = 99;
    expect(plain(p)).toEqual(plain(want));
  });

  it('throws away step extras it cannot make sense of', () => {
    const raw: any = JSON.parse(JSON.stringify(emptyProject()));
    raw.patterns[0].mods[0] = [9999, -4, 'x', null, 3.6];
    raw.groove = 99;
    raw.tracks[0].arpOct = 12;
    const p = sanitize(raw);
    expect(p.patterns[0].mods[0].slice(0, 5)).toEqual([511, 0, 0, 0, 4]);
    expect(p.patterns[0].mods[0].length).toBe(32);
    expect(p.groove).toBeLessThan(6);
    expect(p.tracks[0].arpOct).toBe(3);
  });
});
