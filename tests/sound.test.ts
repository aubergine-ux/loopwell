import { describe, expect, it } from 'vitest';
import { INSERT_TYPES, createInsert } from '../src/core/dsp/inserts';
import { SampleVoice } from '../src/core/dsp/voices';
import { WAVETABLES, WT_SIZE, fft, mipFor, wavetable } from '../src/core/dsp/wavetable';
import { Engine } from '../src/core/engine';
import { PRESETS, PRESET_GROUPS } from '../src/core/presets';
import { renderProject } from '../src/core/render';
import { decodeBeat, encodeBeat, packProject } from '../src/core/share';
import { MAX_SLICES, detectSlices, equalSlices, toFraction, toFrame } from '../src/core/slicer';
import { emptyProject, newInsert, newPattern, newTrack, sanitize, synth, type Project, type SynthParams } from '../src/core/types';
import { plain } from './helpers';

const SR = 48000;
const STEP = 6000;
const rms = (a: Float32Array, from = 0, to = a.length) => Math.sqrt(a.subarray(from, to).reduce((s, x) => s + x * x, 0) / Math.max(1, to - from));
const peak = (a: Float32Array, from = 0, to = a.length) => a.subarray(from, to).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const sine = (hz: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR) * amp);

/** Strength of one frequency in a signal (Goertzel). */
function tone(a: Float32Array, hz: number, from = 0, to = a.length): number {
  let re = 0, im = 0;
  for (let i = from; i < to; i++) { re += a[i] * Math.cos((2 * Math.PI * hz * i) / SR); im += a[i] * Math.sin((2 * Math.PI * hz * i) / SR); }
  return (2 * Math.hypot(re, im)) / (to - from);
}

function voice(data: Float32Array, frames: number, ...args: [number?, number?, boolean?, number?, number?]): Float32Array {
  const v = new SampleVoice();
  const [from = 0, to = data.length, reverse = false, stretch = 1, gate = Infinity] = args;
  v.start({ l: data, r: data }, 1, 1, 1, 0, from, to, reverse, stretch, gate);
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let pos = 0; pos < frames && v.active; pos += 128) v.render(l, r, pos, Math.min(frames, pos + 128));
  return l;
}

/** One dry track of the given kind, ready to play. */
function soloProject(kind: 'drum' | 'synth' | 'slice' = 'synth'): Project {
  const p = emptyProject();
  p.tracks = [newTrack(kind, 0, 'ONE', 'test/s')];
  p.patterns = p.patterns.map(() => newPattern(1));
  p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
  return p;
}

function play(p: Project, frames: number, samples: Record<string, Float32Array> = {}): { l: Float32Array; r: Float32Array } {
  const eng = new Engine(SR);
  for (const id in samples) eng.setSample(id, samples[id]);
  eng.setProject(p);
  eng.play();
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let pos = 0; pos < frames; pos += 128) eng.process(l, r, Math.min(128, frames - pos), pos);
  return { l, r };
}

/** A held note on a plain synth with a few settings changed. */
function note(part: Partial<SynthParams>, pitch = 57, frames = SR): { l: Float32Array; r: Float32Array } {
  const p = soloProject('synth');
  p.tracks[0].synth = synth({ cutoff: 127, reso: 0, env: 0, attack: 0, sustain: 127, release: 0, uni: 1, ...part });
  p.patterns[0].notes[0] = [{ s: 0, l: 16, p: pitch, v: 127 }];
  return play(p, frames);
}

describe('sampler voices', () => {
  // a ramp, so every output sample says which input frame it came from
  const ramp = Float32Array.from({ length: 4000 }, (_, i) => i / 4000);

  it('plays just one slice of a sample', () => {
    const out = voice(ramp, 3000, 1000, 2000);
    expect(out[100]).toBeCloseTo(1100 / 4000, 4);
    expect(out[900]).toBeCloseTo(1900 / 4000, 4);
    expect(peak(out, 1000)).toBe(0); // nothing after the slice ends
  });

  it('plays backwards', () => {
    const out = voice(ramp, 4200, 0, 4000, true);
    expect(out[500]).toBeCloseTo(3499 / 4000, 2);
    expect(out[3000]).toBeCloseTo(999 / 4000, 2);
    expect(out[3000]).toBeLessThan(out[500]);
  });

  it('stops when the note that holds it ends', () => {
    const out = voice(ramp, 3000, 0, 4000, false, 1, 500);
    expect(peak(out, 300, 480)).toBeGreaterThan(0.05);
    expect(peak(out, 620)).toBe(0);
  });

  it('time-stretches without changing the pitch', () => {
    const src = sine(440, SR / 2); // half a second
    for (const ratio of [0.5, 2, 3]) {
      const out = voice(src, SR * 2, 0, src.length, false, ratio);
      let last = 0;
      for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 0.01) last = i;
      // the length scales (give or take a grain) ...
      expect(Math.abs(last - src.length * ratio)).toBeLessThan(4200);
      // ... and it is still a 440 Hz tone: same number of cycles per second, not shifted up or down
      const mid = Math.floor((src.length * ratio) / 2);
      let crossings = 0;
      for (let i = mid - 4000; i < mid + 4000; i++) if (out[i] >= 0 !== out[i - 1] >= 0) crossings++;
      expect(Math.abs(crossings - (2 * 440 * 8000) / SR)).toBeLessThan(5);
      // the grains are lined up with each other, so the level stays steady instead of warbling
      const levels = Array.from({ length: 16 }, (_, k) => rms(out, mid - 4000 + k * 500, mid - 3500 + k * 500));
      expect(Math.min(...levels)).toBeGreaterThan(Math.max(...levels) * 0.75);
    }
  });

  it('keeps the attack of a stretched drum', () => {
    const hit = Float32Array.from({ length: 8000 }, (_, i) => Math.exp(-i / 800) * Math.sin(i / 3));
    expect(peak(voice(hit, 600, 0, hit.length, false, 2), 0, 64)).toBeGreaterThan(0.8);
  });
});

describe('sliced tracks', () => {
  // four bursts at different frequencies, so each slice can be told apart
  const loop = new Float32Array(16000);
  [300, 600, 1200, 2400].forEach((hz, k) => loop.set(sine(hz, 3000).map((x, i) => x * Math.exp(-i / 600)), k * 4000));

  it('finds the hits in a loop', () => {
    const found = detectSlices(loop, undefined, SR);
    expect(found.length).toBe(4);
    found.forEach((f, k) => expect(Math.abs(f - k * 4000)).toBeLessThan(100)); // within 2 ms
    expect(detectSlices(new Float32Array(20000), undefined, SR)).toEqual([0]); // silence
    expect(detectSlices(new Float32Array(10), undefined, SR)).toEqual([0]);
  });

  it('finds quieter hits when asked to be more sensitive, and never too many', () => {
    const quiet = loop.slice();
    for (let i = 8000; i < 12000; i++) quiet[i] *= 0.04;
    expect(detectSlices(quiet, undefined, SR, 0).length).toBeLessThan(detectSlices(quiet, undefined, SR, 1).length);
    const busy = new Float32Array(SR * 4);
    for (let k = 0; k < 200; k++) busy.set(sine(900, 300).map((x, i) => x * Math.exp(-i / 60)), k * 960);
    expect(detectSlices(busy, undefined, SR, 1).length).toBeLessThanOrEqual(MAX_SLICES);
  });

  it('stores slice points as fractions that survive a round trip', () => {
    expect(equalSlices(65536, 4)).toEqual([0, 16384, 32768, 49152]);
    for (const f of [0, 1, 4000, 15999]) expect(Math.abs(toFrame(toFraction(f, 16000), 16000) - f)).toBeLessThanOrEqual(1);
  });

  it('plays the slice each note asks for, and each one cuts the last', () => {
    const p = soloProject('slice');
    p.tracks[0].slices = equalSlices(65536, 4);
    p.patterns[0].notes[0] = [{ s: 0, l: 4, p: 2, v: 127 }, { s: 1, l: 4, p: 0, v: 127 }, { s: 3, l: 1, p: 7, v: 127 }];
    const { l } = play(p, STEP * 6, { 'test/s': loop });
    expect(tone(l, 1200, 200, 2600)).toBeGreaterThan(0.05); // slice 3
    expect(tone(l, 300, 200, 2600)).toBeLessThan(0.02);
    expect(tone(l, 300, STEP + 200, STEP + 2600)).toBeGreaterThan(0.05); // slice 1 took over on the next step
    expect(tone(l, 1200, STEP + 200, STEP + 2600)).toBeLessThan(0.02);
    // a note beyond the last slice wraps round (7 -> slice 4)
    expect(tone(l, 2400, STEP * 3 + 200, STEP * 3 + 2600)).toBeGreaterThan(0.05);
    // a one-step note is cut after a step even though the slice is longer than that at half speed
    p.tracks[0].stretch = 96;
    p.patterns[0].notes[0] = [{ s: 0, l: 1, p: 0, v: 127 }];
    expect(peak(play(p, STEP * 3, { 'test/s': loop }).l, STEP + 200, STEP * 3)).toBe(0);
  });

  it('reverses and stretches a drum hit', () => {
    const p = soloProject('drum');
    const hit = Float32Array.from({ length: 6000 }, (_, i) => Math.exp(-i / 500) * Math.sin(i / 4));
    p.patterns[0].steps[0][0] = 127;
    const fwd = play(p, STEP * 2, { 'test/s': hit }).l;
    p.tracks[0].reverse = true;
    const back = play(p, STEP * 2, { 'test/s': hit }).l;
    expect(rms(fwd, 0, 1000)).toBeGreaterThan(rms(fwd, 4000, 5000) * 20);
    expect(rms(back, 4500, 5500)).toBeGreaterThan(rms(back, 500, 1500) * 20);
    p.tracks[0].reverse = false;
    p.tracks[0].stretch = 96; // twice as long
    const long = play(p, STEP * 3, { 'test/s': hit }).l;
    expect(rms(long, 3000, 5000)).toBeGreaterThan(rms(fwd, 3000, 5000) * 5);
    expect(peak(fwd, 7000, 9000)).toBe(0);
    expect(peak(long, 7000, 9000)).toBeGreaterThan(0);
  });
});

describe('wavetables', () => {
  it('has a working FFT', () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / 64) + 0.5 * Math.sin((2 * Math.PI * 9 * i) / 64));
    const orig = re.slice(), im = new Float64Array(64);
    fft(re, im);
    expect(re[5]).toBeCloseTo(32, 6);
    expect(im[9]).toBeCloseTo(-16, 6);
    expect(Math.abs(re[7]) + Math.abs(im[7])).toBeLessThan(1e-9);
    fft(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i] / 64).toBeCloseTo(orig[i], 9);
  });

  it('builds every table band-limited, normalised and free of DC', () => {
    WAVETABLES.forEach((_, index) => {
      const t = wavetable(index);
      expect(t.frames.length).toBe(9);
      for (const m of [0, 4, 8]) {
        const top = (WT_SIZE / 2) >> m;
        for (const f of [0, 7, 15]) {
          const frame = t.frames[m][f];
          expect(frame.length).toBe(WT_SIZE);
          expect(Math.abs(frame.reduce((s, x) => s + x, 0) / WT_SIZE)).toBeLessThan(1e-4);
          expect(peak(frame)).toBeLessThanOrEqual(1.3); // smoothing off harmonics can overshoot a little
          // nothing above this level's top harmonic
          const re = Float64Array.from(frame), im = new Float64Array(WT_SIZE);
          fft(re, im);
          let above = 0;
          for (let h = top; h <= WT_SIZE / 2; h++) above = Math.max(above, Math.hypot(re[h], im[h]));
          expect(above).toBeLessThan(1e-3);
        }
      }
      expect(peak(t.frames[0][8])).toBeGreaterThan(0.3);
    });
    expect(wavetable(3)).toBe(wavetable(3)); // built once
  });

  it('picks a level that keeps every harmonic under Nyquist', () => {
    for (const hz of [30, 110, 440, 1760, 7040, 15000]) {
      const dt = hz / SR, top = (WT_SIZE / 2) >> mipFor(dt);
      expect((top - 1) * hz).toBeLessThan(SR / 2 + hz);
    }
    expect(mipFor(30 / SR)).toBe(0);
  });

  it('plays a wavetable without aliasing at a high note', () => {
    // C8 on the brightest pulse frame: everything in the output must be a harmonic of the note
    const { l } = note({ wave: 4, pos: 127 }, 108, SR / 2);
    const f0 = 440 * Math.pow(2, (108 - 69) / 12);
    expect(tone(l, f0, 8000, 20000)).toBeGreaterThan(0.02);
    for (const stray of [f0 * 0.5, f0 * 1.37, f0 * 2.6, 1000]) expect(tone(l, stray, 8000, 20000)).toBeLessThan(0.002);
  });

  it('plays a sine until the audio thread has been handed the table', () => {
    const p = soloProject('synth');
    p.tracks[0].synth = synth({ wave: 9, pos: 127, cutoff: 127, env: 0, sustain: 127, uni: 1 });
    const eng = new Engine(SR);
    eng.buildTables = false;
    eng.setProject(p);
    const run = () => { const l = new Float32Array(12288), r = new Float32Array(12288); eng.trigger(0, 127, 57); for (let i = 0; i < l.length; i += 128) eng.process(l, r, 128, i); return l; };
    const before = run();
    expect(tone(before, 220, 2000, 8000)).toBeGreaterThan(0.1);
    expect(tone(before, 660, 2000, 8000)).toBeLessThan(0.005);
    eng.setTable(5, wavetable(5).frames);
    for (let i = 0; i < 40; i++) eng.process(new Float32Array(128), new Float32Array(128), 128);
    expect(tone(run(), 660, 2000, 8000)).toBeGreaterThan(0.02); // the folded wave has strong odd harmonics
  });
});

describe('synth', () => {
  const A3 = 220;

  it('mixes in a second oscillator at its own pitch', () => {
    const one = note({ wave: 3 }).l, two = note({ wave: 3, wave2: 3, semi2: 12, mix: 64 }).l;
    expect(tone(one, A3 * 2, 4000, 20000)).toBeLessThan(0.002);
    expect(tone(two, A3 * 2, 4000, 20000)).toBeGreaterThan(0.05);
    expect(tone(two, A3, 4000, 20000)).toBeGreaterThan(0.05);
    const only2 = note({ wave: 3, wave2: 3, semi2: 7, fine2: 50, mix: 127 }).l;
    expect(tone(only2, A3, 4000, 20000)).toBeLessThan(0.01);
    expect(tone(only2, A3 * Math.pow(2, 7.5 / 12), 4000, 20000)).toBeGreaterThan(0.1);
  });

  it('adds noise', () => {
    const clean = note({ wave: 3 }).l, noisy = note({ wave: 3, noise: 127 }).l;
    expect(tone(clean, 5000, 4000, 20000)).toBeLessThan(1e-4);
    expect(rms(noisy, 4000, 20000)).toBeGreaterThan(rms(clean, 4000, 20000) * 1.05);
  });

  it('stacks detuned voices and spreads them across the stereo field', () => {
    const mono = note({ wave: 0, uni: 1 });
    expect(mono.l).toEqual(mono.r);
    const wide = note({ wave: 0, uni: 5, detune: 60, spread: 127 });
    const diff = wide.l.map((x, i) => x - wide.r[i]);
    expect(rms(diff, 4000, 40000)).toBeGreaterThan(rms(wide.l, 4000, 40000) * 0.2);
    // detuning makes the stack beat: its loudness wanders, a single voice's does not
    const env = (a: Float32Array) => Array.from({ length: 20 }, (_, k) => rms(a, 4000 + k * 2000, 6000 + k * 2000));
    const wobble = (e: number[]) => (Math.max(...e) - Math.min(...e)) / Math.max(...e);
    expect(wobble(env(mono.l))).toBeLessThan(0.02);
    expect(wobble(env(note({ wave: 0, uni: 5, detune: 60 }).l))).toBeGreaterThan(0.1);
    // and a stack is about as loud as one voice, not five times louder
    expect(rms(wide.l) / rms(mono.l)).toBeLessThan(1.6);
  });

  it('sounds the way the first version did when the new settings are left alone', () => {
    // saw and square were always two oscillators 7 cents apart; that is now a two-voice stack
    const s = synth({ wave: 0 });
    expect([s.uni, s.detune, s.mix, s.noise, s.lfoAmt, s.menvAmt]).toEqual([2, 9, 0, 0, 0, 0]);
    expect(synth({ wave: 3 }).uni).toBe(1);
    const old = sanitize({ tracks: [{ kind: 'synth', synth: { wave: 1, cutoff: 50, reso: 10, env: 5, attack: 1, decay: 2, sustain: 3, release: 4 } }] }).tracks[0].synth;
    expect(old).toEqual(synth({ wave: 1, cutoff: 50, reso: 10, env: 5, attack: 1, decay: 2, sustain: 3, release: 4 }));
    // two saws 7 cents apart beat slowly against each other, about 0.9 times a second at A3:
    // the fundamental all but vanishes when they are out of step and comes back half a beat later
    const l = note({ wave: 0, uni: 2, detune: 9 }, 57, SR * 2).l;
    const level = Array.from({ length: 40 }, (_, k) => tone(l, A3, k * 2400, k * 2400 + 2400));
    expect(Math.min(...level)).toBeLessThan(0.02);
    expect(Math.max(...level)).toBeGreaterThan(0.15);
    const dip = level.indexOf(Math.min(...level.slice(0, 20)));
    expect(level[dip + 11]).toBeGreaterThan(0.15);
  });

  it('lets the LFO and the mod envelope move any target', () => {
    const steady = note({ wave: 3 }).l;
    // LFO to pitch: energy spreads away from the exact note
    const vib = note({ wave: 3, lfoAmt: 40, lfoRate: 100, lfoDest: 1 }).l;
    expect(tone(vib, A3, 4000, 44000)).toBeLessThan(tone(steady, A3, 4000, 44000) * 0.8);
    // LFO to level: tremolo
    const trem = note({ wave: 3, lfoAmt: 63, lfoRate: 90, lfoShape: 3, lfoDest: 8 }).l;
    const chunks = Array.from({ length: 40 }, (_, k) => rms(trem, 4000 + k * 1000, 5000 + k * 1000));
    expect(Math.min(...chunks)).toBeLessThan(Math.max(...chunks) * 0.2);
    // LFO to pan: left and right take turns
    const pan = note({ wave: 3, lfoAmt: 63, lfoRate: 80, lfoDest: 9 });
    expect(rms(pan.l.map((x, i) => x - pan.r[i]))).toBeGreaterThan(0.01);
    // mod envelope to cutoff: bright at the start, dark later
    const pluck = note({ wave: 0, cutoff: 20, menvAmt: 63, menvDecay: 30, menvDest: 0 }).l;
    expect(tone(pluck, A3 * 9, 200, 2600)).toBeGreaterThan(tone(pluck, A3 * 9, 30000, 32400) * 5);
    // mod envelope to wavetable position: the tone changes over the note
    const morph = note({ wave: 5, pos: 0, menvAmt: 63, menvDecay: 40, menvDest: 2 }).l;
    expect(tone(morph, A3 * 12, 300, 2700)).toBeGreaterThan(tone(morph, A3 * 12, 40000, 42400) * 3);
    // a tempo-synced LFO follows the tempo
    const sync = (bpm: number) => {
      const p = soloProject('synth');
      p.bpm = bpm;
      p.tracks[0].synth = synth({ wave: 3, cutoff: 127, env: 0, sustain: 127, uni: 1, lfoSync: true, lfoRate: 56, lfoShape: 3, lfoAmt: 63, lfoDest: 8 }); // quarter notes
      p.patterns[0].notes[0] = [{ s: 0, l: 32, p: 57, v: 127 }];
      const l = play(p, SR * 2).l;
      let flips = 0;
      for (let k = 1; k < 200; k++) if ((rms(l, k * 480, k * 480 + 480) > 0.02) !== (rms(l, k * 480 - 480, k * 480) > 0.02)) flips++;
      return flips;
    };
    expect(sync(120)).toBeGreaterThanOrEqual(7);
    expect(sync(120)).toBeLessThanOrEqual(9);
    expect(sync(60)).toBeLessThanOrEqual(5);
  });

  it('ships presets that all make sound and survive saving', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(20);
    for (const g of PRESET_GROUPS) expect(PRESETS.some((x) => x.group === g)).toBe(true);
    expect(new Set(PRESETS.map((x) => x.name)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      const p = soloProject('synth');
      p.tracks[0].synth = preset.synth;
      p.patterns[0].notes[0] = [{ s: 0, l: 8, p: preset.note, v: 110 }];
      expect(sanitize(p).tracks[0].synth, preset.name).toEqual(preset.synth);
      const { l, r } = play(p, SR);
      expect(rms(l) + rms(r), preset.name).toBeGreaterThan(0.004);
      expect(peak(l), preset.name).toBeLessThan(1.01);
      expect(l.every(Number.isFinite), preset.name).toBe(true);
    }
  });
});

describe('insert effects', () => {
  const run = (type: (typeof INSERT_TYPES)[number], p: number[], input: Float32Array, key?: Float32Array) => {
    const fx = createInsert(type, SR);
    const l = input.slice(), r = input.slice();
    for (let i = 0; i < l.length; i += 128) {
      const n = Math.min(128, l.length - i);
      fx.process(l.subarray(i, i + n), r.subarray(i, i + n), n, p, key?.subarray(i, i + n), key?.subarray(i, i + n));
    }
    return l;
  };
  const db = (a: number, b: number) => 20 * Math.log10(a / b);

  it('EQ boosts and cuts each band by the right amount', () => {
    const low = sine(60, SR / 2), mid = sine(1100, SR / 2), high = sine(12000, SR / 2);
    expect(db(rms(run('eq', [127, 64, 64, 64], low), 8000), rms(low, 8000))).toBeCloseTo(15, 0);
    expect(db(rms(run('eq', [0, 64, 64, 64], low), 8000), rms(low, 8000))).toBeCloseTo(-15, 0);
    expect(Math.abs(db(rms(run('eq', [127, 64, 64, 64], high), 8000), rms(high, 8000)))).toBeLessThan(0.5);
    expect(db(rms(run('eq', [64, 64, 127, 64], high), 8000), rms(high, 8000))).toBeCloseTo(15, 0);
    expect(db(rms(run('eq', [64, 127, 64, 64], mid), 8000), rms(mid, 8000))).toBeGreaterThan(13);
    expect(run('eq', [64, 64, 64, 64], mid)).toEqual(mid); // flat is untouched
  });

  it('drive adds harmonics in each of its three shapes and stays in bounds', () => {
    const x = sine(200, SR / 4, 0.8);
    for (const shape of [0, 64, 127]) {
      const y = run('drive', [110, 127, 127, shape], x);
      expect(tone(y, 600, 2000)).toBeGreaterThan(0.015);
      expect(peak(y)).toBeLessThan(1.2);
    }
    expect(run('drive', [110, 127, 0, 0], x)).toEqual(x); // mix at zero is dry
  });

  it('chorus thickens, crusher degrades', () => {
    const x = sine(440, SR / 2);
    const ch = run('chorus', [60, 127, 127, 127], x);
    expect(rms(ch.map((v, i) => v - x[i]), 4000)).toBeGreaterThan(0.1);
    const cr = run('crush', [127, 0, 127, 0], x); // 2 bits
    expect(new Set(Array.from(cr.subarray(1000, 5000), (v) => v.toFixed(4))).size).toBeLessThanOrEqual(5);
    const held = run('crush', [0, 127, 127, 0], x); // every 40th sample
    let repeats = 0;
    for (let i = 1001; i < 5000; i++) if (held[i] === held[i - 1]) repeats++;
    expect(repeats).toBeGreaterThan(3800);
  });

  it('the sidechain ducks to its key and lets go afterwards', () => {
    const pad = sine(300, SR, 0.5);
    const key = new Float32Array(SR);
    key.set(sine(60, 4800, 0.9), 12000);
    const out = run('duck', [1, 60, 127, 0], pad, key);
    expect(rms(out, 4000, 10000)).toBeCloseTo(rms(pad, 4000, 10000), 3);
    expect(rms(out, 13000, 16000)).toBeLessThan(rms(pad, 13000, 16000) * 0.3);
    expect(rms(out, 40000, 46000)).toBeGreaterThan(rms(pad, 40000, 46000) * 0.95);
  });

  it('runs a track through its rack in order, and ducks to another track', () => {
    const p = soloProject('synth');
    p.tracks[0].synth = synth({ wave: 3, cutoff: 127, env: 0, sustain: 127, uni: 1 });
    p.patterns[0].notes[0] = [{ s: 0, l: 16, p: 45, v: 127 }];
    const dry = play(p, SR / 2).l;
    const crush = newInsert('crush'); crush.p = [120, 0, 127, 0];
    const eq = newInsert('eq'); eq.p = [64, 64, 0, 64]; // cut the highs
    p.tracks[0].fx = [crush, eq];
    const a = play(p, SR / 2).l;
    p.tracks[0].fx = [eq, crush];
    const b = play(p, SR / 2).l;
    // crushing then cutting the highs is duller than cutting first and crushing after
    expect(tone(a, 110, 4000)).toBeGreaterThan(0.05);
    expect(rms(a.map((v, i) => v - b[i]), 4000)).toBeGreaterThan(0.005);
    const hf = (x: Float32Array) => rms(x.map((v, i) => (i ? v - x[i - 1] : 0)), 4000);
    expect(hf(a)).toBeLessThan(hf(b) * 0.7);
    // an effect that is switched off does nothing
    p.tracks[0].fx = [{ ...crush, on: false }];
    expect(play(p, SR / 2).l).toEqual(dry);

    // track 2 is a loud click on every beat; track 1 ducks to it even though track 2 is muted
    p.tracks.push(newTrack('drum', 1, 'KEY', 'test/k'));
    for (const pat of p.patterns) { pat.steps.push(new Array(32).fill(0)); pat.notes.push([]); pat.mods.push(new Array(32).fill(0)); }
    p.patterns[0].steps[1][4] = 127;
    p.tracks[1].mute = true;
    const duck = newInsert('duck'); duck.p = [2, 80, 127, 20];
    p.tracks[0].fx = [duck];
    const key = sine(80, 3000, 0.9);
    const out = play(p, STEP * 8, { 'test/k': key }).l;
    expect(rms(out, STEP * 4 + 600, STEP * 4 + 2400)).toBeLessThan(rms(out, STEP * 2, STEP * 2 + 1800) * 0.4);
  });
});

describe('sound settings in links and files', () => {
  it('round-trips the bigger synth, sampler settings and racks', () => {
    const p = emptyProject();
    p.tracks[0].kind = 'slice'; p.tracks[0].slices = [0, 1234, 40000, 65535]; p.tracks[0].reverse = true; p.tracks[0].stretch = 20; p.tracks[0].note = 3;
    p.tracks[1].stretch = 100;
    p.tracks[2].fx = INSERT_TYPES.map((t, i) => ({ type: t, on: i % 2 === 0, p: [i, 127 - i, 64 + i, 3 * i] }));
    p.tracks[6].synth = synth({ wave: 11, pos: 99, wave2: 4, pos2: 5, semi2: -24, fine2: 50, mix: 127, noise: 3, uni: 5, detune: 127, spread: 1,
      lfoShape: 4, lfoRate: 1, lfoSync: true, lfoAmt: -64, lfoDest: 10, menvAttack: 127, menvDecay: 0, menvAmt: 63, menvDest: 9 });
    p.patterns[2].notes[0] = [{ s: 3, l: 2, p: 3, v: 90 }];
    const back = decodeBeat(encodeBeat(p))!;
    expect(plain(back)).toEqual(plain(p));
    expect(sanitize(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('costs nothing in a link when it is not used', () => {
    const p = emptyProject();
    const before = packProject(p).length;
    p.tracks[7].synth.lfoAmt = 5;
    expect(packProject(p).length).toBeGreaterThan(before + 18);
    p.tracks[7].synth.lfoAmt = 0;
    expect(packProject(p).length).toBe(before);
  });

  it('cleans up broken sound settings', () => {
    const t = sanitize({ tracks: [{ kind: 'slice', slices: [70000, 5, 5, -1, 'x', 900], stretch: 999, fx: [{ type: 'nope' }, { type: 'eq', p: [999, -4] }, 3],
      synth: { wave: 77, uni: 99, lfoDest: 40, semi2: -90 } }] }).tracks[0];
    expect(t.slices).toEqual([0, 5, 900, 65535]);
    expect(t.stretch).toBe(127);
    expect(t.fx).toEqual([{ type: 'eq', on: true, p: [127, 0, 64, 64] }]);
    expect([t.synth.wave, t.synth.uni, t.synth.lfoDest, t.synth.semi2]).toEqual([11, 5, 10, -24]);
  });

  it('bounces a song that uses all of it without blowing up', async () => {
    const p = emptyProject();
    p.tracks[6].synth = PRESETS.find((x) => x.name === 'Super Saw')!.synth;
    p.tracks[6].fx = INSERT_TYPES.map((t) => newInsert(t));
    p.patterns[0].notes[6] = [{ s: 0, l: 8, p: 48, v: 110 }, { s: 0, l: 8, p: 55, v: 110 }];
    const r = await renderProject(p, {}, { sampleRate: 44100, chain: [0] });
    expect(r.l.every(Number.isFinite)).toBe(true);
    expect(rms(r.l)).toBeGreaterThan(0.01);
    expect(peak(r.l)).toBeLessThanOrEqual(1);
  });
});
