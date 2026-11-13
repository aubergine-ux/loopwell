import { describe, expect, it } from 'vitest';
import { detectBpm, detectKey, waveformPeaks } from '../src/core/analyze';
import { DRUM_MODELS } from '../src/core/dsp/instruments';
import { Engine } from '../src/core/engine';
import { paramIndex, PARAMS } from '../src/core/params';
import { decodeBeat, encodeBeat } from '../src/core/share';
import { defaultDsyn, emptyProject, newPattern, newTrack, sanitize, type Project, type TrackKind } from '../src/core/types';
import { plain } from './helpers';

const SR = 48000;

function solo(kind: TrackKind): Project {
  const p = emptyProject();
  p.tracks = [newTrack(kind, 0, 'T')];
  p.patterns = p.patterns.map(() => newPattern(1));
  p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
  return p;
}
function render(p: Project, frames: number, setup?: (e: Engine) => void): Float32Array {
  const eng = new Engine(SR);
  eng.setProject(p);
  setup?.(eng);
  const l = new Float32Array(frames), r = new Float32Array(frames);
  eng.process(l, r, frames);
  return l;
}
/** Pitch of a stretch of audio in Hz, from its rising zero crossings. */
function hz(buf: Float32Array, from: number, to: number): number {
  let first = -1, last = -1, n = 0;
  for (let i = from + 1; i < to; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { if (first < 0) first = i; last = i; n++; }
  return n > 1 ? ((n - 1) * SR) / (last - first) : 0;
}
const rms = (buf: Float32Array, from = 0, to = buf.length) => { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / (to - from)); };
const peak = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

describe('808 bass', () => {
  const quiet = (p: Project) => { p.tracks[0].bass.punch = 0; p.tracks[0].bass.drive = 0; return p; };

  it('plays the note it is asked for, in tune', () => {
    for (const note of [28, 33, 36, 43]) {
      const out = render(quiet(solo('bass')), SR, (e) => e.noteOn(0, note, 110));
      expect(hz(out, SR * 0.3, SR * 0.9)).toBeCloseTo(midiHz(note), 0);
    }
  });

  it('slides between overlapping notes instead of starting again', () => {
    const p = quiet(solo('bass'));
    p.tracks[0].bass.glide = 80;
    const eng = new Engine(SR);
    eng.setProject(p);
    const l = new Float32Array(SR * 2), r = new Float32Array(SR * 2);
    eng.noteOn(0, 36, 110);
    eng.process(l, r, SR / 2, 0);
    eng.noteOn(0, 48, 110); // still held: a slide
    eng.process(l, r, SR + SR / 2, SR / 2);
    expect(hz(l, SR * 0.2, SR * 0.45)).toBeCloseTo(midiHz(36), 0);
    // just after the second note the pitch is between the two, and it gets there in the end
    const mid = hz(l, SR * 0.5, SR * 0.56);
    expect(mid).toBeGreaterThan(midiHz(36) * 1.03);
    expect(mid).toBeLessThan(midiHz(48) * 0.97);
    expect(hz(l, SR * 1.4, SR * 1.9)).toBeCloseTo(midiHz(48), 0);
    // no new attack: the level keeps falling straight through the join
    expect(rms(l, SR * 0.5, SR * 0.55)).toBeLessThan(rms(l, SR * 0.4, SR * 0.45));
  });

  it('starts again on every note when glide is off, and is one voice either way', () => {
    const p = quiet(solo('bass'));
    p.tracks[0].bass.glide = 0;
    const eng = new Engine(SR);
    eng.setProject(p);
    const l = new Float32Array(SR), r = new Float32Array(SR);
    eng.noteOn(0, 36, 110);
    eng.process(l, r, SR / 2, 0);
    eng.noteOn(0, 48, 110);
    eng.process(l, r, SR / 2, SR / 2);
    expect(hz(l, SR * 0.52, SR * 0.6)).toBeCloseTo(midiHz(48), 0);
    expect(rms(l, SR * 0.52, SR * 0.57)).toBeGreaterThan(rms(l, SR * 0.4, SR * 0.45));
  });

  it('a sequenced line slides only where notes overlap', () => {
    const p = quiet(solo('bass'));
    p.tracks[0].bass.glide = 60;
    p.patterns[0].notes[0] = [{ s: 0, l: 5, p: 36, v: 110 }, { s: 4, l: 2, p: 43, v: 110 }, { s: 8, l: 2, p: 36, v: 110 }];
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play();
    const l = new Float32Array(6000 * 12), r = new Float32Array(6000 * 12);
    eng.process(l, r, l.length);
    const slide = hz(l, 6000 * 4, 6000 * 4 + 2400);
    expect(slide).toBeGreaterThan(midiHz(36) * 1.02);
    expect(slide).toBeLessThan(midiHz(43));
    // the third note comes after a gap, so it is a fresh hit at full level
    expect(peak(l.subarray(6000 * 8, 6000 * 8 + 1200))).toBeGreaterThan(peak(l.subarray(6000 * 5, 6000 * 6)) * 0.99);
  });

  it('follows the song key', () => {
    const p = quiet(solo('bass'));
    p.tracks[0].bass.key = 0;
    p.scaleRoot = 5; // written in C, song now in F: up a fourth
    expect(hz(render(p, SR, (e) => e.noteOn(0, 36, 110)), SR * 0.3, SR * 0.9)).toBeCloseTo(midiHz(41), 0);
    p.scaleRoot = 10; // B flat is nearer going down
    expect(hz(render(p, SR, (e) => e.noteOn(0, 36, 110)), SR * 0.3, SR * 0.9)).toBeCloseTo(midiHz(34), 0);
    p.tracks[0].bass.follow = false;
    expect(hz(render(p, SR, (e) => e.noteOn(0, 36, 110)), SR * 0.3, SR * 0.9)).toBeCloseTo(midiHz(36), 0);
  });

  it('a held note is released by its own note-off, even when the key has moved it', () => {
    const p = quiet(solo('bass'));
    p.scaleRoot = 3;
    const eng = new Engine(SR);
    eng.setProject(p);
    const l = new Float32Array(SR), r = new Float32Array(SR);
    eng.noteOn(0, 36, 110);
    eng.process(l, r, SR / 4, 0);
    eng.noteOff(0, 36);
    eng.process(l, r, SR / 2, SR / 4);
    expect(peak(l.subarray(SR / 2, SR * 0.75))).toBe(0);
  });

  it('drive adds harmonics without getting much louder, and never clicks or blows up', () => {
    const clean = quiet(solo('bass'));
    const dirty = quiet(solo('bass'));
    dirty.tracks[0].bass.drive = 127; dirty.tracks[0].bass.tone = 127;
    const a = render(clean, SR / 2, (e) => e.noteOn(0, 36, 127));
    const b = render(dirty, SR / 2, (e) => e.noteOn(0, 36, 127));
    // the steepest slope is far higher once it is squared off
    const slope = (x: Float32Array) => { let m = 0; for (let i = 4000; i < 20000; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
    expect(slope(b)).toBeGreaterThan(slope(a) * 3);
    expect(peak(b)).toBeLessThan(1.01);
    expect(rms(b) / rms(a)).toBeLessThan(2.2);
    expect(Math.abs(a[0])).toBeLessThan(0.01);
    expect(Math.abs(b[0])).toBeLessThan(0.01);
  });

  it('rings for about as long as the decay knob says, then is silent', () => {
    const p = quiet(solo('bass'));
    p.tracks[0].bass.decay = 0; // 120 ms
    const out = render(p, SR, (e) => e.noteOn(0, 36, 127));
    expect(peak(out.subarray(0, 2000))).toBeGreaterThan(0.3);
    expect(peak(out.subarray(SR * 0.2))).toBeLessThan(0.002);
    expect(peak(out.subarray(SR * 0.5))).toBe(0);
  });
});

describe('drum synth', () => {
  it('every model makes a sound that starts on the hit and dies away', () => {
    DRUM_MODELS.forEach((name, model) => {
      const p = solo('dsyn');
      p.tracks[0].dsyn = defaultDsyn(model);
      const out = render(p, SR * 3, (e) => e.trigger(0, 127));
      expect(peak(out.subarray(0, 2400)), name).toBeGreaterThan(0.1);
      expect(peak(out), name).toBeLessThan(1.2);
      expect(peak(out.subarray(SR * 2.9)), name).toBe(0);
      expect(out.every(Number.isFinite), name).toBe(true);
    });
  });

  it('the kick is low, the hat is high', () => {
    const crossings = (model: number) => {
      const p = solo('dsyn');
      p.tracks[0].dsyn = defaultDsyn(model);
      const out = render(p, 4800, (e) => e.trigger(0, 127));
      let n = 0;
      for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) n++;
      return n;
    };
    expect(crossings(0)).toBeLessThan(60);
    expect(crossings(2)).toBeGreaterThan(600);
    expect(crossings(1)).toBeGreaterThan(crossings(0));
  });

  it('the knobs do what they say', () => {
    const hit = (set: (d: Project['tracks'][0]['dsyn']) => void) => {
      const p = solo('dsyn');
      set(p.tracks[0].dsyn);
      return render(p, SR, (e) => e.trigger(0, 127));
    };
    // decay: longer
    expect(rms(hit((d) => { d.decay = 110; }), SR * 0.3, SR * 0.5)).toBeGreaterThan(rms(hit((d) => { d.decay = 20; }), SR * 0.3, SR * 0.5) * 5 + 1e-6);
    // tune: an octave up doubles the settled pitch of the kick
    const lowHz = hz(hit((d) => { d.snap = 0; d.decay = 127; }), SR * 0.1, SR * 0.4);
    const highHz = hz(hit((d) => { d.snap = 0; d.decay = 127; d.tune = 12; }), SR * 0.1, SR * 0.4);
    expect(highHz / lowHz).toBeCloseTo(2, 1);
    // velocity
    const p = solo('dsyn');
    expect(peak(render(p, 4800, (e) => e.trigger(0, 40)))).toBeLessThan(peak(render(p, 4800, (e) => e.trigger(0, 127))) * 0.3);
  });

  it('plays from the step grid, on the exact frame, and the same every time', () => {
    const p = solo('dsyn');
    p.tracks[0].dsyn = defaultDsyn(2);
    [0, 3, 7].forEach((s) => (p.patterns[0].steps[0][s] = 100));
    const run = (block: number) => {
      const eng = new Engine(SR);
      eng.setProject(p);
      eng.play();
      const l = new Float32Array(6000 * 16), r = new Float32Array(6000 * 16);
      for (let pos = 0; pos < l.length; pos += block) eng.process(l, r, Math.min(block, l.length - pos), pos);
      return l;
    };
    const a = run(128);
    for (const s of [3, 7]) {
      expect(peak(a.subarray(s * 6000 - 200, s * 6000))).toBeLessThan(0.003);
      expect(peak(a.subarray(s * 6000, s * 6000 + 60))).toBeGreaterThan(0.02);
    }
    const b = run(1000);
    expect(a.every((v, i) => v === b[i])).toBe(true);
  });

  it('its knobs can be automated', () => {
    for (const id of ['bdrive', 'bdecay', 'btone', 'bglide', 'dtune', 'ddecay', 'dtone', 'dsnap']) expect(paramIndex(id)).toBeGreaterThan(26);
    expect(PARAMS[26].id).toBe('stretch'); // nothing that was already in a link has moved
    const p = solo('dsyn');
    p.tracks[0].dsyn.snap = 0; p.tracks[0].dsyn.decay = 127;
    p.patterns[0].steps[0][0] = 127;
    p.songMode = true;
    p.arr.lanes = [{ id: 'l', track: 0, param: 'dtune', on: true, points: [{ t: 0, v: 12 }] }];
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.play();
    const l = new Float32Array(SR / 2), r = new Float32Array(SR / 2);
    eng.process(l, r, l.length);
    expect(hz(l, SR * 0.1, SR * 0.4)).toBeCloseTo(96, -1);
  });
});

describe('instrument compatibility', () => {
  it('carries an 808 and a drum synth in a link, exactly', () => {
    const p = emptyProject();
    p.tracks[6].kind = 'bass';
    p.tracks[6].bass = { glide: 0, drive: 127, decay: 3, tone: 99, punch: 1, follow: false, key: 11 };
    p.tracks[6].synth.uni = 4; // settings it had as a synth come back if it is turned into one again
    p.tracks[0].kind = 'dsyn';
    p.tracks[0].dsyn = { model: 3, tune: -24, decay: 127, tone: 0, snap: 64 };
    p.tracks[3].kind = 'dsyn';
    p.patterns[0].steps[0][5] = 77;
    p.patterns[0].steps[3][0] = 100;
    p.patterns[1].notes[6].push({ s: 2, l: 4, p: 31, v: 90 });
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
  });

  it('costs nothing in a link that has neither', () => {
    const p = emptyProject();
    const before = encodeBeat(p).length;
    p.tracks[0].dsyn.tone = 99; // settings of an instrument the track isn't using are not sent
    expect(encodeBeat(p).length).toBe(before);
  });

  it('gives tracks from older files and links the default instruments', () => {
    const old: any = JSON.parse(JSON.stringify(emptyProject()));
    for (const t of old.tracks) { delete t.bass; delete t.dsyn; }
    expect(plain(sanitize(old))).toEqual(plain(emptyProject()));
  });

  it('cleans up nonsense', () => {
    const raw: any = JSON.parse(JSON.stringify(emptyProject()));
    raw.tracks[0].kind = 'theremin';
    raw.tracks[1].kind = 'dsyn';
    raw.tracks[1].dsyn = { model: 9, tune: 99, decay: -1 };
    raw.tracks[2].kind = 'bass';
    raw.tracks[2].bass = { key: 40, glide: 'x' };
    const p = sanitize(raw);
    expect(p.tracks[0].kind).toBe('drum');
    expect(p.tracks[1].dsyn).toEqual({ model: 3, tune: 24, decay: 0, tone: 50, snap: 50 });
    expect(p.tracks[2].bass.key).toBe(11);
    expect(p.tracks[2].bass.glide).toBe(40);
  });
});

describe('sample analysis', () => {
  /** A drum loop: a thump on every beat and a tick on the off-beats. */
  function loop(bpm: number, beats: number, sr = 44100): Float32Array {
    const beat = (60 / bpm) * sr;
    const out = new Float32Array(Math.round(beat * beats));
    for (let b = 0; b < beats * 2; b++) {
      const at = Math.round((b * beat) / 2);
      for (let i = 0; i < 3000 && at + i < out.length; i++) {
        const e = Math.exp(-i / (b % 2 ? 200 : 900));
        out[at + i] += b % 2 ? (((i * 7919) % 13) / 6.5 - 1) * e * 0.4 : Math.sin(i * 0.02) * e;
      }
    }
    return out;
  }
  const tone = (notes: number[], seconds: number, sr = 44100) => {
    const out = new Float32Array(Math.round(seconds * sr));
    const each = Math.floor(out.length / notes.length);
    notes.forEach((n, k) => {
      for (let i = 0; i < each; i++) {
        const t = i / sr, f = midiHz(n);
        out[k * each + i] = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t)) * 0.4 * Math.exp(-t * 2);
      }
    });
    return out;
  };

  it('finds the tempo of a loop', () => {
    for (const bpm of [70, 86, 100, 120, 128, 140, 174]) {
      const got = detectBpm(loop(bpm, 8), 44100)!;
      // half and double time are the same loop
      const fold = [got, got * 2, got / 2].reduce((a, b) => (Math.abs(b - bpm) < Math.abs(a - bpm) ? b : a));
      expect(fold, `${bpm} bpm heard as ${got}`).toBeCloseTo(bpm, 0);
    }
  });
  it('finds a tempo that does not fit the file length', () => {
    const l = loop(97, 8).subarray(0, 44100 * 4.3);
    const got = detectBpm(l, 44100)!;
    expect(Math.abs(got - 97)).toBeLessThan(2.5);
  });
  it('says nothing about one-shots, silence and drones', () => {
    expect(detectBpm(loop(120, 1), 44100)).toBeNull();
    expect(detectBpm(new Float32Array(44100 * 4), 44100)).toBeNull();
    expect(detectBpm(tone([60], 4), 44100)).toBeNull();
  });

  it('finds the key of a melody', () => {
    const cMajor = tone([60, 64, 67, 72, 65, 69, 62, 67, 71, 60, 64, 67, 60], 6);
    expect(detectKey(cMajor, 44100)?.name).toBe('C major');
    const aMinor = tone([57, 60, 64, 69, 62, 65, 64, 68, 71, 57, 60, 64, 57], 6);
    expect(detectKey(aMinor, 44100)?.name).toBe('A minor');
    const fSharpMinor = tone([54, 57, 61, 66, 59, 62, 61, 65, 68, 54, 57, 61, 54], 6, 48000);
    expect(detectKey(fSharpMinor, 48000)?.name).toBe('F♯ minor');
  });
  it('says nothing about drums, noise and very short sounds', () => {
    expect(detectKey(loop(120, 8), 44100)).toBeNull();
    let s = 1;
    const noise = Float32Array.from({ length: 44100 * 2 }, () => { s = (s * 1103515245 + 12345) | 0; return (s / 2147483648) * 0.5; });
    expect(detectKey(noise, 44100)).toBeNull();
    expect(detectKey(new Float32Array(100), 44100)).toBeNull();
  });

  it('draws an outline of any length of audio at any width', () => {
    const x = tone([60], 1);
    const pk = waveformPeaks(x, 200);
    expect(pk.length).toBe(400);
    expect(pk[0]).toBeLessThanOrEqual(0);
    expect(Math.max(...pk)).toBeGreaterThan(0.3);
    expect(Math.max(...pk)).toBeLessThanOrEqual(0.57);
    expect(waveformPeaks(new Float32Array(3), 50).every(Number.isFinite)).toBe(true);
    expect(waveformPeaks(new Float32Array(0), 10).every((v) => v === 0)).toBe(true);
  });
});
