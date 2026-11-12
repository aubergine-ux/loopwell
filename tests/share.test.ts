import { describe, expect, it } from 'vitest';
import { DEMOS } from '../src/core/demos';
import { beatFromHash, beatUrl, decodeBeat, encodeBeat, packProject, unpackProject } from '../src/core/share';
import { emptyProject, newPattern, newTrack, sanitize, type Project } from '../src/core/types';

/** Deterministic pseudo-random project that exercises every field. */
function randomProject(seed: number): Project {
  let s = seed;
  const r = (n: number) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; };
  const p = emptyProject();
  p.name = `beat ${seed} ✨`;
  p.bpm = 40 + r(201); p.swing = r(101); p.steps = r(2) ? 32 : 16;
  p.songMode = !!r(2); p.scaleLock = !!r(2); p.scaleRoot = r(12); p.scaleType = r(10); p.master = r(128);
  p.song = Array.from({ length: 1 + r(12) }, () => r(4));
  const f = p.fx;
  f.revSize = r(128); f.revDamp = r(128); f.revLevel = r(128); f.dlyTime = r(6); f.dlyFb = r(128); f.dlyLevel = r(128);
  f.filter = r(128) - 64; f.filterRes = r(128); f.compOn = !!r(2); f.compThresh = r(128); f.compRatio = r(128); f.compMakeup = r(128);
  const n = 1 + r(8);
  p.tracks = Array.from({ length: n }, (_, i) => {
    const t = newTrack(r(3) ? 'drum' : 'synth', r(8), `T${i}`, `${['boom', 'punch', 'dust', 'glass'][r(4)]}/${['kick', 'snare', 'hat', 'sub'][r(4)]}`);
    t.vol = r(128); t.pan = r(128) - 64;
    t.mute = !!r(2); t.solo = !!r(2); t.filter = r(128) - 64; t.rev = r(128); t.dly = r(128);
    // a link only carries the settings that apply to the track's kind
    if (t.kind === 'drum') { t.tune = r(49) - 24; t.decay = r(128); }
    else {
      t.sample = newTrack('synth', 0, '').sample;
      t.note = r(128);
      t.synth = { wave: r(4), cutoff: r(128), reso: r(128), env: r(128), attack: r(128), decay: r(128), sustain: r(128), release: r(128) };
    }
    return t;
  });
  p.patterns = [0, 1, 2, 3].map((pi) => {
    const pat = newPattern(n);
    if (pi === 3) return pat; // leave one empty
    p.tracks.forEach((t, ti) => {
      if (t.kind === 'drum') for (let st = 0; st < 32; st++) { if (r(3) === 0) pat.steps[ti][st] = pi === 0 ? 100 : 1 + r(127); }
      else for (let k = r(20); k > 0; k--) pat.notes[ti].push({ s: r(32), l: 1 + r(8), p: r(128), v: 1 + r(127) });
    });
    return pat;
  });
  return p;
}

describe('share links', () => {
  it('round-trips an empty project', () => {
    const p = emptyProject();
    expect(decodeBeat(encodeBeat(p))).toEqual(p);
  });

  it('round-trips every field exactly', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const p = randomProject(seed);
      expect(decodeBeat(encodeBeat(p)), `seed ${seed}`).toEqual(p);
    }
  });

  it('round-trips the demo beats and keeps them short', () => {
    for (const d of DEMOS) {
      const p = d.make();
      const code = encodeBeat(p);
      expect(decodeBeat(code)).toEqual(p);
      expect(code.length, d.name).toBeLessThan(700);
    }
  });

  it('is URL-safe and stays well under common URL length limits when full', () => {
    const p = emptyProject();
    p.steps = 32;
    for (const pat of p.patterns) p.tracks.forEach((t, ti) => {
      for (let s = 0; s < 32; s++) {
        if (t.kind === 'drum') pat.steps[ti][s] = 1 + ((s * 37 + ti * 11) % 127);
        else pat.notes[ti].push({ s, l: 1 + (s % 4), p: 36 + ((s * 5) % 36), v: 60 + s });
      }
    });
    const code = encodeBeat(p);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(2000);
    expect(decodeBeat(code)).toEqual(p);
  });

  it('an empty beat is a short link', () => {
    expect(encodeBeat(emptyProject()).length).toBeLessThan(200);
  });

  it('builds and parses full URLs', () => {
    const p = DEMOS[0].make();
    const url = beatUrl(p, 'https://example.com/loopwell/#old');
    expect(url.startsWith('https://example.com/loopwell/#b=')).toBe(true);
    expect(beatFromHash(new URL(url).hash)).toEqual(p);
    expect(beatFromHash('')).toBeNull();
    expect(beatFromHash('#something-else')).toBeNull();
  });

  it('keeps the reference to a custom sample but not its audio', () => {
    const p = emptyProject();
    p.tracks[0].sample = 'user/3f9a12cd';
    p.tracks[0].name = 'MY KICK';
    const back = decodeBeat(encodeBeat(p))!;
    expect(back.tracks[0].sample).toBe('user/3f9a12cd');
    expect(back.tracks[0].name).toBe('MY KICK');
  });

  it('rejects garbage without throwing', () => {
    const good = encodeBeat(DEMOS[1].make());
    const bad = ['', '!!!', 'AAAA', 'not base64 at all', good.slice(0, 20), good.slice(5), 'x'.repeat(30000),
      good.slice(0, -4) + 'AAAA', '%E0%A4%A'];
    for (const b of bad) expect(() => decodeBeat(b)).not.toThrow();
    expect(decodeBeat('')).toBeNull();
    expect(decodeBeat('!!!')).toBeNull();
    expect(decodeBeat(good.slice(0, 20))).toBeNull();
  });

  it('never yields an invalid project from corrupted bytes', () => {
    const packed = packProject(DEMOS[2].make());
    for (let i = 0; i < packed.length; i++) {
      const copy = packed.slice();
      copy[i] ^= 0xff;
      let p: Project | null = null;
      try { p = unpackProject(copy); } catch { continue; }
      expect(sanitize(p)).toEqual(p); // already clean: every value in range
      expect(p.tracks.length).toBeGreaterThan(0);
      expect(p.patterns.length).toBe(4);
    }
  });

  it('rejects an unknown version', () => {
    const packed = packProject(emptyProject()).slice();
    packed[0] = 99;
    expect(() => unpackProject(packed)).toThrow();
  });
});
