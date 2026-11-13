import { describe, expect, it } from 'vitest';
import { createInsert, INSERTS, INSERT_TYPES } from '../src/core/dsp/inserts';
import { vocalLatency } from '../src/core/dsp/vocal';
import { Engine } from '../src/core/engine';
import { emptyProject, newPattern, newTrack } from '../src/core/types';

const SR = 48000;
const hz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * A voice: a buzz at `pitch` (a MIDI note, may be fractional, may glide) shaped by two formants, like a held vowel.
 * `formant` scales where those formants sit.
 */
function voice(seconds: number, pitch: number | ((t: number) => number), formant = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let ph = 0;
  // two resonators
  const res = [700 * formant, 1200 * formant].map((f) => { const r = 0.985, w = (2 * Math.PI * f) / SR; return { a1: -2 * r * Math.cos(w), a2: r * r, y1: 0, y2: 0 }; });
  for (let i = 0; i < n; i++) {
    const f = hz(typeof pitch === 'number' ? pitch : pitch(i / SR));
    ph += f / SR;
    let x = 0;
    if (ph >= 1) { ph -= 1; x = 1; } // one pulse per cycle
    let y = 0;
    for (const r of res) { const v = x - r.a1 * r.y1 - r.a2 * r.y2; r.y2 = r.y1; r.y1 = v; y += v; }
    out[i] = y * 0.05 * Math.min(1, i / 2000) * Math.min(1, (n - i) / 2000);
  }
  return out;
}

function through(type: (typeof INSERT_TYPES)[number], p: number[], x: Float32Array, key: [number, number] = [0, 0], block = 128): [Float32Array, Float32Array] {
  const ins = createInsert(type, SR);
  ins.setKey?.(key[0], key[1]);
  const l = x.slice(), r = x.slice();
  for (let pos = 0; pos < x.length; pos += block) {
    const n = Math.min(block, x.length - pos);
    ins.process(l.subarray(pos, pos + n), r.subarray(pos, pos + n), n, p);
  }
  return [l, r];
}

/** The pitch of a stretch of audio as a MIDI note, from how far apart its cycles are (autocorrelation). */
function pitchOf(x: Float32Array, from: number, to: number, lo = 70, hi = 1000): number {
  const a = Math.round(from * SR), n = Math.round((to - from) * SR);
  let best = 0, score = -Infinity;
  for (let lag = Math.floor(SR / hi); lag <= Math.ceil(SR / lo); lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i += 2) s += x[a + i] * x[a + i + lag];
    s /= n - lag;
    if (s > score * 1.02) { score = s; best = lag; }
  }
  // sharpen between lags
  const c = (lag: number) => { let s = 0; for (let i = 0; i < n - lag; i += 2) s += x[a + i] * x[a + i + lag]; return s / (n - lag); };
  const y0 = c(best - 1), y1 = c(best), y2 = c(best + 1);
  const shift = y0 - 2 * y1 + y2 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
  return 69 + 12 * Math.log2(SR / (best + shift) / 440);
}
const rms = (x: Float32Array, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };
/** Where the weight of the spectrum sits, in Hz (a crude brightness measure). */
function centroid(x: Float32Array, from: number, to: number): number {
  const a = Math.round(from * SR), n = 4096;
  let num = 0, den = 0;
  for (let f = 200; f <= 4000; f += 50) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n), ph = (2 * Math.PI * f * i) / SR; re += x[a + i] * w * Math.cos(ph); im += x[a + i] * w * Math.sin(ph); }
    const m = re * re + im * im;
    num += m * f; den += m;
  }
  return num / den;
}
const LAT = vocalLatency(SR) / SR;

describe('pitch correction', () => {
  it('pulls a flat or sharp note onto the nearest note of the key', () => {
    // C major. A note 40 cents flat of E, one 35 cents sharp of G, and one between the cracks nearer to A than to G sharp
    for (const [sung, want] of [[63.6, 64], [67.35, 67], [68.6, 69], [59.7, 60]]) {
      const [l] = through('tune', [127, 127, 0, 64], voice(1.2, sung));
      expect(pitchOf(l, 0.5, 1.0), `${sung} should come out as ${want}`).toBeCloseTo(want, 1);
    }
  });

  it('uses the key it is told, or any semitone when set to chromatic', () => {
    // 61 is C sharp: not in C major (it goes to C or D), in D major it is the seventh and stays
    const x = voice(1.2, 61.1);
    const inC = pitchOf(through('tune', [127, 127, 0, 64], x, [0, 0])[0], 0.5, 1.0);
    expect(Math.abs(inC - 61)).toBeGreaterThan(0.8);
    expect(pitchOf(through('tune', [127, 127, 0, 64], x, [2, 0])[0], 0.5, 1.0)).toBeCloseTo(61, 1);
    expect(pitchOf(through('tune', [127, 127, 127, 64], x, [0, 0])[0], 0.5, 1.0)).toBeCloseTo(61, 1);
  });

  it('amount sets how far it goes, and zero leaves the pitch alone', () => {
    const x = voice(1.2, 63.6);
    expect(pitchOf(through('tune', [127, 0, 0, 64], x)[0], 0.5, 1.0)).toBeCloseTo(63.6, 1);
    const halfway = pitchOf(through('tune', [127, 64, 0, 64], x)[0], 0.5, 1.0);
    expect(halfway).toBeGreaterThan(63.7);
    expect(halfway).toBeLessThan(63.9);
  });

  it('speed: slow eases into the note, fast snaps', () => {
    // steady on D, then jumps to a flat E
    const x = voice(1.6, (t) => (t < 0.8 ? 62 : 63.6));
    const fast = through('tune', [127, 127, 0, 64], x)[0], slow = through('tune', [0, 127, 0, 64], x)[0];
    const soon = [0.8 + LAT + 0.04, 0.8 + LAT + 0.12] as const;
    expect(pitchOf(fast, ...soon)).toBeCloseTo(64, 0.5);
    const easing = pitchOf(slow, ...soon);
    expect(easing).toBeLessThan(63.9);
    expect(easing).toBeGreaterThan(63.5);
    expect(pitchOf(slow, 1.35, 1.55)).toBeGreaterThan(easing); // and it gets closer as it goes
  });

  it('holds a note through vibrato instead of flickering between two', () => {
    const x = voice(1.5, (t) => 64 + 0.45 * Math.sin(2 * Math.PI * 5.5 * t));
    const [l] = through('tune', [127, 127, 0, 64], x);
    for (const at of [0.4, 0.6, 0.8, 1.0, 1.2]) expect(pitchOf(l, at, at + 0.08)).toBeCloseTo(64, 0.5);
  });

  it('keeps the level, adds nothing to silence, and is the same whatever the block size', () => {
    const x = voice(1, 63.6);
    const [a] = through('tune', [127, 127, 0, 64], x, [0, 0], 128);
    expect(rms(a, 20000, 40000) / rms(x, 20000, 40000)).toBeGreaterThan(0.75);
    expect(rms(a, 20000, 40000) / rms(x, 20000, 40000)).toBeLessThan(1.3);
    for (const block of [1, 37, 1024]) {
      const [b] = through('tune', [127, 127, 0, 64], x, [0, 0], block);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      expect(diff).toBe(0);
    }
    const [q] = through('tune', [127, 127, 0, 64], new Float32Array(SR));
    expect(Math.max(...q.map(Math.abs))).toBe(0);
    expect(a.every(Number.isFinite)).toBe(true);
  });

  it('lets things without a pitch through as they are, only later', () => {
    let s = 5;
    const noise = Float32Array.from({ length: SR }, () => { s = (s * 1103515245 + 12345) | 0; return (s / 2147483648) * 0.2; });
    const [l] = through('tune', [127, 127, 0, 64], noise);
    const lat = vocalLatency(SR);
    let err = 0;
    for (let i = 10000; i < 30000; i++) err = Math.max(err, Math.abs(l[i + lat] - noise[i]));
    expect(err).toBeLessThan(0.02);
  });
});

describe('formant and pitch shift', () => {
  it('moves the formants and leaves the pitch where it was', () => {
    const x = voice(1.2, 57);
    const plain = centroid(x, 0.5, 0.6);
    const [up] = through('formant', [96, 64, 127, 0], x); // half an octave up
    const [down] = through('formant', [32, 64, 127, 0], x);
    expect(pitchOf(up, 0.5, 1.0)).toBeCloseTo(57, 1);
    expect(pitchOf(down, 0.5, 1.0)).toBeCloseTo(57, 1);
    expect(centroid(up, 0.55, 0.65) / plain).toBeGreaterThan(1.2);
    expect(centroid(down, 0.55, 0.65) / plain).toBeLessThan(0.85);
  });

  it('moves the pitch and leaves the formants where they were', () => {
    const x = voice(1.2, 57);
    const [l] = through('formant', [64, 64 + Math.round((5 / 12) * 64), 127, 0], x); // up a fourth
    expect(pitchOf(l, 0.5, 1.0)).toBeCloseTo(62, 1);
    // compare with the same vowel really sung a fourth higher, and with what speeding the recording up would give
    // (the same notes, but with the formants dragged up along with them: the "chipmunk" sound)
    const sung = centroid(voice(1.2, 62), 0.5, 0.6), spedUp = centroid(voice(1.2, 62, Math.pow(2, 5 / 12)), 0.5, 0.6);
    const got = centroid(l, 0.55, 0.65);
    expect(Math.abs(got / sung - 1)).toBeLessThan(0.1);
    expect(Math.abs(got - sung)).toBeLessThan(Math.abs(got - spedUp) * 0.5);
  });

  it('at its neutral settings gives back what went in, only later', () => {
    const x = voice(1, 60);
    const [l] = through('formant', [64, 64, 127, 0], x);
    const lat = vocalLatency(SR);
    let err = 0;
    for (let i = 12000; i < 30000; i++) err = Math.max(err, Math.abs(l[i + lat] - x[i]));
    // the grains follow the voice's cycle, which wobbles by a fraction of a sample, so it is close rather than exact
    expect(err).toBeLessThan(0.1 * Math.max(...x.map(Math.abs)));
  });
});

describe('harmony and doubling', () => {
  /** How much of a note is in the sound: its strength at that pitch next to the whole. */
  const has = (x: Float32Array, note: number) => {
    const f = hz(note), a = Math.round(0.5 * SR), n = 16384;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re += x[a + i] * w * Math.cos((2 * Math.PI * f * i) / SR); im += x[a + i] * w * Math.sin((2 * Math.PI * f * i) / SR); }
    return Math.sqrt(re * re + im * im) / n;
  };

  it('adds a voice a third above, in key', () => {
    // singing C in C major: a third above is E. Singing D: F (a minor third). The interval follows the scale.
    for (const [sung, third] of [[60, 64], [62, 65], [67, 71]]) {
      const x = voice(1.4, sung);
      const [l] = through('harm', [64 + 19, 64, 0, 127], x); // two scale steps up
      expect(has(l, third), `a third above ${sung}`).toBeGreaterThan(has(x, third) * 4 + has(l, sung) * 0.15);
      expect(has(l, sung)).toBeGreaterThan(has(x, sung) * 0.6); // the voice itself is still there
    }
  });

  it('two voices, above and below', () => {
    const x = voice(1.4, 64);
    const [l, r] = through('harm', [64 + 19, 64 - 19, 0, 127], x); // E: G above, C below
    expect(has(l, 67) + has(r, 67)).toBeGreaterThan(has(x, 67) * 6);
    expect(has(l, 60) + has(r, 60)).toBeGreaterThan(has(x, 60) * 6);
  });

  it('doubling widens the voice without moving its pitch', () => {
    const x = voice(1.4, 60);
    const [l, r] = through('harm', [64, 64, 127, 127], x);
    expect(pitchOf(l, 0.5, 1.0)).toBeCloseTo(60, 0.5);
    let diff = 0;
    for (let i = 20000; i < 40000; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff / 20000).toBeGreaterThan(rms(x, 20000, 40000) * 0.1); // left and right are no longer the same
    expect(rms(l, 20000, 40000)).toBeGreaterThan(rms(x, 20000, 40000));
  });

  it('with everything off or the mix down, it is only the voice, later', () => {
    const x = voice(1, 60);
    const lat = vocalLatency(SR);
    for (const p of [[64, 64, 0, 127], [64 + 19, 64, 127, 0]]) {
      const [l] = through('harm', p, x);
      let err = 0;
      for (let i = 12000; i < 30000; i++) err = Math.max(err, Math.abs(l[i + lat] - x[i]));
      expect(err).toBe(0);
    }
  });
});

describe('compressor and de-esser', () => {
  const tone = (f: number, amp: number, n = SR) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR) * amp);

  it('the compressor turns loud things down and leaves quiet things alone', () => {
    const p = [64, 64, 0, 0]; // threshold -24 dB, about 10:1
    const loud = through('comp', p, tone(300, 0.8))[0], quiet = through('comp', p, tone(300, 0.02))[0];
    expect(rms(loud, 24000, 48000)).toBeLessThan(rms(tone(300, 0.8)) * 0.35);
    expect(rms(quiet, 24000, 48000)).toBeCloseTo(rms(tone(300, 0.02)), 3);
    const made = through('comp', [64, 64, 0, 64], tone(300, 0.8))[0];
    expect(rms(made, 24000, 48000) / rms(loud, 24000, 48000)).toBeCloseTo(Math.pow(10, 12.1 / 20), 1);
  });

  it('the de-esser takes the hiss down and leaves the voice alone', () => {
    const p = [64, 90, 127, 0];
    const body = tone(250, 0.4), hiss = tone(7500, 0.4);
    expect(rms(through('deess', p, hiss)[0], 24000, 48000)).toBeLessThan(rms(hiss) * 0.3);
    expect(rms(through('deess', p, body)[0], 24000, 48000)).toBeCloseTo(rms(body), 2);
    // a quiet top end is left as it is
    const air = tone(7500, 0.001);
    expect(rms(through('deess', p, air)[0], 24000, 48000)).toBeCloseTo(rms(air), 4);
  });
});

describe('vocal effects in the engine', () => {
  it('a rack with every vocal effect on plays, in the song\'s key', () => {
    const p = emptyProject();
    p.tracks = [newTrack('drum', 0, 'VOX', 'test/vox')];
    p.patterns = p.patterns.map(() => newPattern(1));
    p.patterns[0].steps[0][0] = 127;
    p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
    p.scaleRoot = 0; p.scaleType = 0;
    p.tracks[0].fx = [{ type: 'tune', on: true, p: [127, 127, 0, 64] }, { type: 'comp', on: true, p: [20, 20, 20, 0] }, { type: 'deess', on: true, p: [64, 70, 90, 0] }];
    const eng = new Engine(SR);
    eng.setSample('test/vox', voice(1.2, 63.6));
    eng.setProject(p);
    eng.play();
    const l = new Float32Array(SR * 1.3), r = new Float32Array(SR * 1.3);
    for (let pos = 0; pos < l.length; pos += 128) eng.process(l, r, Math.min(128, l.length - pos), pos);
    expect(pitchOf(l, 0.5, 1.0)).toBeCloseTo(64, 1);
    // the same rack in another key pulls the same note somewhere else
    p.scaleRoot = 1; // C sharp major: 63.6 is nearer to D sharp (63)
    const e2 = new Engine(SR);
    e2.setSample('test/vox', voice(1.2, 63.6));
    e2.setProject(p);
    e2.play();
    const l2 = new Float32Array(SR * 1.3), r2 = new Float32Array(SR * 1.3);
    for (let pos = 0; pos < l2.length; pos += 128) e2.process(l2, r2, Math.min(128, l2.length - pos), pos);
    expect(pitchOf(l2, 0.5, 1.0)).toBeCloseTo(63, 1);
  });

  it('every effect has four knobs with defaults in range', () => {
    for (const t of INSERT_TYPES) {
      expect(INSERTS[t].knobs.length).toBe(4);
      for (const k of INSERTS[t].knobs) { expect(k.def).toBeGreaterThanOrEqual(0); expect(k.def).toBeLessThanOrEqual(127); }
    }
    expect(INSERT_TYPES.slice(0, 5)).toEqual(['eq', 'drive', 'chorus', 'crush', 'duck']); // links made before the vocal effects still mean the same
  });
});

describe('vocal chains and lyrics in files and links', () => {
  it('every chain is a valid rack that fits', async () => {
    const { VOCAL_CHAINS } = await import('../src/core/vocalchains');
    const { MAX_INSERTS, sanitize } = await import('../src/core/types');
    expect(VOCAL_CHAINS.map((c) => c.id)).toEqual(['clean', 'trap', 'lofi', 'radio']);
    for (const c of VOCAL_CHAINS) {
      expect(c.fx.length).toBeLessThanOrEqual(MAX_INSERTS);
      const p = emptyProject();
      p.tracks[0].fx = c.fx;
      expect(sanitize(JSON.parse(JSON.stringify(p))).tracks[0].fx, c.name).toEqual(c.fx);
    }
  });

  it('lyrics and vocal effects travel in a link, and cost nothing when there are none', async () => {
    const { decodeBeat, encodeBeat } = await import('../src/core/share');
    const { plain } = await import('./helpers');
    const p = emptyProject();
    const bare = encodeBeat(p).length;
    p.lyrics = [{ at: 0, text: 'Up before the sun' }, { at: 16, text: '' }, { at: 300, text: 'Üñïçödé ✨ and "quotes"' }, { at: 8000, text: 'x'.repeat(120) }];
    p.tracks[2].fx = [{ type: 'tune', on: true, p: [127, 100, 0, 64] }, { type: 'harm', on: false, p: [83, 45, 90, 70] }, { type: 'deess', on: true, p: [1, 2, 3, 0] }];
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
    expect(encodeBeat(emptyProject()).length).toBe(bare);
  });

  it('cleans up lyrics from a file: sorted, trimmed to length, no more than two hundred', async () => {
    const { sanitize } = await import('../src/core/types');
    const raw: any = JSON.parse(JSON.stringify(emptyProject()));
    raw.lyrics = [{ at: 50, text: 'second' }, { at: 2, text: 'first' }, { at: -9, text: 7 }, null, { at: 1e9, text: 'y'.repeat(500) }, ...Array.from({ length: 300 }, (_, i) => ({ at: 100 + i, text: 'more' }))];
    const p = sanitize(raw);
    expect(p.lyrics.length).toBe(200);
    expect(p.lyrics[0]).toEqual({ at: 0, text: '' });
    expect(p.lyrics.map((l) => l.at)).toEqual([...p.lyrics.map((l) => l.at)].sort((a, b) => a - b));
    expect(Math.max(...p.lyrics.map((l) => l.text.length))).toBe(120);
    const old: any = JSON.parse(JSON.stringify(emptyProject()));
    delete old.lyrics;
    expect(sanitize(old).lyrics).toEqual([]);
  });
});
