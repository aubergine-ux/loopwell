import { describe, expect, it } from 'vitest';
import { DEMOS } from '../src/core/demos';
import { beatFromHash, beatUrl, decodeBeat, encodeBeat, packProject, unpackProject } from '../src/core/share';
import { deflateSync } from 'fflate';
import { PARAMS, paramsFor } from '../src/core/params';
import { emptyProject, newId, newPattern, newTrack, resolveOverlaps, sanitize, type Project } from '../src/core/types';
import { plain } from './helpers';

// Links made by version 1.0 (the demo links from its README). They must keep opening forever.
const V1_LINKS = ['jU7BSsNAEJ1NtulisaTSQw7WNNBDkCIIgiaGsNskoDTEJSkeeh7RgicRD17iL_g9_Qk_wU9xNoh6ETrsW3jvMe8Nq2H4jqtkbcdreRSGYwF8eZ0twWsfpQQQvaZSdcG8Fg11eVYqbXXsBDz7Sq1sr02NNeU3uqi4d7swLOS6qLO-1yZSJnDKF6ppYH6WwvH4IOiiIl4WKmfpLIb5MIzKUl5UAoAxgjWoNvcPz9P8afNy1x-NSHpFRKBxXfq2W1Iwjn9enpP6RqksjnuWFaBD2CPssxkOLR8dYBHaLCFDomAFDpgkI8Hf8E-zjbhTwYRyJlTgU4FPOYd_C9R3QUaG7I7u5uPfXDMWiACFMJc6kQYnIUgtnHPCJSHVXw', 'bY5BS8MwGIa_plnNBkrx1FPpZqkVUdCTC6E01pSZjllWd7Dn3DdQL7uU_QX_m_9nX9cVdhjh4eXNl_B81iO_GhtR1ySsU_9FTBjQ4j0rAq8xaQrABtVCLtX4UH1waTaX5cRr8nbo2TP5eXMsAf0o1SL0GtG2mJZqmd16jY6xPdFXWVVEjHwQuR9t2hdTWqivinAWOnmcJDp9zn0KANbw7ff7J5iv1xt7hxfW1hj3uk2-dV1Mzlf_GIZ3h-MfYOQwoGBH5sKKzIjcmUsSGgZOosGRiEJmmjkcSRCJKL1zOoNx_zoF7x2rEwfgvr1j0DuG1v3R83DOM0UEkiKZ3gM', 'LYtPS8NAEMVnsmtY_EfAIovUUMFDDiJtLajBwyZxbUNDXNrm0oO0MAcPomDQQy77Kf0o3t0tzvAGfvPeQ4KjLVGyZmqt4iTpCeDzspgPpX1VCkDsLetsoUfSkseIF1VmxjuagGSzbHUjbeqtAX82up5Ie-cp4UYviltp1YsyTyO2bHK2AQDzfhV_-8A9z3VVBaZ3DeP9h7weqtUG4WD6tm3bwezj67PFTOElduTHNQEQELuu-f1pcPckSt36-x9RIEBEmKZpCGFModNxcEGRiOmM9encSUBQEkNNIcvpkD1S5PgEKzplJfX5lP4A', 'lY7PSsNAEIdnky3GKCVq0ZxKqaUspEEtHjSI7CakjW2IodlTT_6ZgycPgpde8go-hA_kC_RZ6mxQ8Vp2P2Z-O7vsx7LjdoxXN0v7cim7QnQc4PO7ZO75NUoJ4LSqQi3Sgyb2weNJrspDv87N0LczpY_8-taEHr8v06Lj15FJgpfpIjnx69ETpQseq6qCYaGh77bFg7lxzSutYph0xyC6AzkZybHmAMDc8v31-aWXPL6hrQZ0sEJEzzPNCj6oRNF6TQUx-tvcvNxszJDy_7ULTKBF2CzAFtUdNkTHErjHTnGf-jb1DmdSc5YQU2KmXUsSCTElZlp9_nig99WIIIIx2tIkJJOQTM7JJCSTgExCMhFkEpDJ2a9JSmRETr_HRNpYuFahvwE'];


/** Deterministic pseudo-random project that exercises every field. */
function randomProject(seed: number): Project {
  let s = seed;
  const r = (n: number) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; };
  const p = emptyProject();
  p.name = `beat ${seed} ✨`;
  p.bpm = 40 + r(201); p.swing = r(101); p.steps = r(2) ? 32 : 16;
  p.songMode = !!r(2); p.scaleLock = !!r(2); p.scaleRoot = r(12); p.scaleType = r(10); p.master = r(128);
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
  p.patterns = [0, 1, 2, 3, 4, 5, 6, 7].map((pi) => {
    const pat = newPattern(n);
    if (pi === 3 || pi > 5) return pat; // leave some empty
    p.tracks.forEach((t, ti) => {
      if (t.kind === 'drum') for (let st = 0; st < 32; st++) { if (r(3) === 0) pat.steps[ti][st] = pi === 0 ? 100 : 1 + r(127); }
      else for (let k = r(20); k > 0; k--) pat.notes[ti].push({ s: r(32), l: 1 + r(8), p: r(128), v: 1 + r(127) });
    });
    return pat;
  });
  // a timeline with everything on it
  const a = p.arr;
  a.clips = resolveOverlaps(Array.from({ length: r(40) }, () => ({
    id: newId(), track: r(n), pattern: r(8), start: r(600), len: 1 + r(90), offset: r(p.steps),
  })), p.steps);
  a.lanes = [];
  for (let k = r(5); k > 0; k--) {
    const track = r(n + 1) - 1;
    const defs = paramsFor(p, track).filter((d) => !a.lanes.some((l) => l.track === track && l.param === d.id));
    const def = defs[r(defs.length)];
    let t = 0;
    a.lanes.push({
      id: newId(), track, param: def.id, on: !!r(2),
      points: Array.from({ length: r(30) }, () => ({ t: (t += 1 + r(40)), v: def.min + r(def.max - def.min + 1) })),
    });
  }
  let at = 0;
  a.tempo = Array.from({ length: r(4) }, () => ({ at: (at += 1 + r(200)), bpm: 40 + r(201) }));
  at = -1;
  a.sigs = Array.from({ length: r(4) }, () => ({ at: (at += 1 + r(200)), num: 1 + r(16), den: [2, 4, 8, 16][r(4)] }));
  at = -1;
  a.markers = Array.from({ length: r(5) }, (_, i) => ({ at: (at += 1 + r(200)), name: `part ${i}`, color: r(8) }));
  a.loopStart = r(100); a.loopEnd = a.loopStart + r(100); a.loopOn = a.loopEnd > a.loopStart && !!r(2);
  return p;
}

describe('share links', () => {
  it('round-trips an empty project', () => {
    const p = emptyProject();
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
  });

  it('round-trips every field exactly', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const p = randomProject(seed);
      expect(plain(decodeBeat(encodeBeat(p))!), `seed ${seed}`).toEqual(plain(p));
    }
  });

  it('round-trips the demo beats and keeps them short', () => {
    for (const d of DEMOS) {
      const p = d.make();
      const code = encodeBeat(p);
      expect(plain(decodeBeat(code)!)).toEqual(plain(p));
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
    expect(plain(decodeBeat(code)!)).toEqual(plain(p));
  });

  it('an empty beat is a short link', () => {
    expect(encodeBeat(emptyProject()).length).toBeLessThan(200);
  });

  it('builds and parses full URLs', () => {
    const p = DEMOS[0].make();
    const url = beatUrl(p, 'https://example.com/loopwell/#old');
    expect(url.startsWith('https://example.com/loopwell/#b=')).toBe(true);
    expect(plain(beatFromHash(new URL(url).hash)!)).toEqual(plain(p));
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
      expect(p.patterns.length).toBe(8);
    }
  });

  it('rejects an unknown version', () => {
    const packed = packProject(emptyProject()).slice();
    packed[0] = 99;
    expect(() => unpackProject(packed)).toThrow();
  });

  it('still opens every link made by version 1', () => {
    expect(V1_LINKS.length).toBe(4);
    V1_LINKS.forEach((code, i) => {
      const p = decodeBeat(code)!;
      expect(p, DEMOS[i].name).not.toBeNull();
      // the old pattern chain arrives as clips on the timeline, and nothing else changes
      expect(plain(p)).toEqual(plain(DEMOS[i].make()));
    });
  });

  it('turns a version 1 chain into looping clips', () => {
    const p = decodeBeat(V1_LINKS[1])!; // Dust Loop: A A A B
    const t0 = p.arr.clips.filter((c) => c.track === 0);
    expect(t0.map((c) => [c.pattern, c.start, c.len])).toEqual([[0, 0, 48], [1, 48, 16]]);
    expect(p.songMode).toBe(true);
  });

  it('skips chunks and trailing bytes it does not know', () => {
    const p = randomProject(7);
    const packed = packProject(p);
    // an unknown chunk (tag 200) with three bytes of payload, appended at the end
    const extra = new Uint8Array([...packed, 200, 3, 1, 2, 3]);
    expect(plain(unpackProject(extra))).toEqual(plain(p));
    // the settings chunk grows by two bytes, as a later version might do
    const len = packed[2];
    const grown = new Uint8Array([packed[0], packed[1], len + 2, ...packed.slice(3, 3 + len), 9, 9, ...packed.slice(3 + len)]);
    expect(plain(unpackProject(grown))).toEqual(plain(p));
  });

  it('leaves an untouched timeline out of the link', () => {
    const p = emptyProject();
    const short = packProject(p).length;
    p.arr.markers.push({ at: 0, name: 'intro', color: 0 });
    expect(packProject(p).length).toBeGreaterThan(short);
    p.arr.markers = [];
    p.steps = 32; // the default clips are now half a pattern long, which is a real arrangement
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
  });

  it('keeps a long song link usable', () => {
    const p = DEMOS[0].make();
    p.arr.clips = [];
    for (let bar = 0; bar < 64; bar++) for (let t = 0; t < 8; t++) if ((bar + t) % 3) p.arr.clips.push({ id: newId(), track: t, pattern: (bar >> 2) % 3, start: bar * 16, len: 16, offset: 0 });
    const lane = { id: newId(), track: 0, param: 'vol', on: true, points: Array.from({ length: 128 }, (_, i) => ({ t: i * 8, v: (i * 37) % 128 })) };
    p.arr.lanes.push(lane);
    const code = encodeBeat(p);
    expect(code.length).toBeLessThan(2000);
    expect(plain(decodeBeat(code)!)).toEqual(plain(p));
  });

  it('refuses a truncated version 2 body', () => {
    const raw = deflateSync(packProject(randomProject(3)).slice(0, 40));
    let s = '';
    for (const b of raw) s += String.fromCharCode(b);
    expect(decodeBeat(btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))).toBeNull();
  });

  it('knows every automatable knob by a stable index', () => {
    // the order of PARAMS is written into links: these must never move
    expect(PARAMS.slice(0, 17).map((d) => d.id)).toEqual(['vol', 'pan', 'filter', 'rev', 'dly', 'tune', 'decay', 'cutoff', 'reso', 'env',
      'master', 'mfilter', 'mres', 'revlvl', 'revsize', 'dlylvl', 'dlyfb']);
  });
});
