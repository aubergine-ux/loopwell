import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAudio } from '../src/core/encode';
import { Engine, METER_CHANNELS } from '../src/core/engine';
import { LoudnessMeter, integratedLoudness, normalize, samplePeak } from '../src/core/loudness';
import { decodeBeat, encodeBeat } from '../src/core/share';
import { emptyProject, newBus, newPattern, newTrack, sanitize, type Project } from '../src/core/types';
import { plain } from './helpers';

const SR = 48000;
const sine = (hz: number, seconds: number, amp: number, sr = SR) => Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr) * amp);
const db = (g: number) => Math.pow(10, g / 20);

describe('loudness', () => {
  it('reads the standard reference tones correctly', () => {
    // the conformance signal of EBU Tech 3341: a stereo 1 kHz sine at -23 dBFS is -23 LUFS
    const x = sine(1000, 20, db(-23));
    expect(integratedLoudness(x, x, SR)).toBeCloseTo(-23, 1);
    const y = sine(1000, 20, db(-33));
    expect(integratedLoudness(y, y, SR)).toBeCloseTo(-33, 1);
    // one channel only is 3 dB down
    expect(integratedLoudness(x, new Float32Array(x.length), SR)).toBeCloseTo(-26, 1);
  });

  it('gives the same answer at other sample rates', () => {
    for (const sr of [44100, 96000, 22050]) {
      const x = sine(1000, 10, db(-23), sr);
      expect(Math.abs(integratedLoudness(x, x, sr) + 23)).toBeLessThan(0.1); // the tolerance the standard allows
    }
  });

  it('hears bass as quieter than the same level of midrange', () => {
    const low = sine(40, 10, 0.25), mid = sine(2500, 10, 0.25);
    expect(integratedLoudness(mid, mid, SR) - integratedLoudness(low, low, SR)).toBeGreaterThan(8);
  });

  it('leaves silence between loud parts out of the reading', () => {
    const loud = sine(1000, 10, db(-23));
    const gappy = new Float32Array(loud.length * 3);
    gappy.set(loud, 0);
    gappy.set(loud, loud.length * 2);
    expect(integratedLoudness(gappy, gappy, SR)).toBeCloseTo(-23, 0);
    expect(integratedLoudness(new Float32Array(SR * 2), undefined, SR)).toBe(-70);
    expect(integratedLoudness(new Float32Array(0), undefined, SR)).toBe(-70);
    expect(integratedLoudness(sine(1000, 0.2, 0.1), undefined, SR)).toBeCloseTo(-20 + 0.0, 0);
  });

  it('meters a running signal, whatever size the blocks are', () => {
    const x = sine(1000, 5, db(-18));
    for (const block of [128, 100, 4096]) {
      const m = new LoudnessMeter(SR);
      for (let pos = 0; pos + block <= x.length; pos += block) m.process(x.subarray(pos, pos + block), x.subarray(pos, pos + block), block);
      expect(m.momentary).toBeCloseTo(-18, 1);
      expect(m.shortTerm).toBeCloseTo(-18, 1);
    }
    const m = new LoudnessMeter(SR);
    expect(m.momentary).toBe(-70);
    const quiet = new Float32Array(SR);
    m.process(x, x, x.length);
    m.process(quiet, quiet, SR);
    expect(m.momentary).toBe(-70); // 400 ms later it has caught up
    expect(m.shortTerm).toBeGreaterThan(-25); // three seconds of memory
  });

  it('normalizes to a target', () => {
    const l = sine(1000, 10, db(-30)), r = l.slice();
    const res = normalize(l, r, SR, 'stream');
    expect(res.from).toBeCloseTo(-30, 1);
    expect(res.to).toBeCloseTo(-14, 1);
    expect(res.limited).toBe(false);
    expect(integratedLoudness(l, r, SR)).toBeCloseTo(-14, 1);
  });

  it('stops short of the target rather than clip', () => {
    // very peaky: a click every 100 ms can't reach -9 LUFS under a -1 dB ceiling
    const l = new Float32Array(SR * 5);
    for (let i = 0; i < l.length; i += 4800) l[i] = 0.5;
    const r = l.slice();
    const res = normalize(l, r, SR, 'loud');
    expect(res.limited).toBe(true);
    expect(samplePeak(l, r)).toBeCloseTo(db(-1), 4);
    expect(res.to).toBeLessThan(-9);
  });

  it('turns down something that is too loud, and leaves things alone when asked', () => {
    const l = sine(1000, 5, 0.9), r = l.slice();
    expect(normalize(l, r, SR, 'quiet').to).toBeCloseTo(-18, 1);
    const a = sine(300, 2, 0.3), b = a.slice();
    expect(normalize(a, b, SR, 'off').gain).toBe(1);
    expect(a).toEqual(sine(300, 2, 0.3));
    const p = sine(300, 2, 0.3), q = p.slice();
    normalize(p, q, SR, 'peak');
    expect(samplePeak(p, q)).toBeCloseTo(db(-1), 4);
    const s = new Float32Array(1000);
    expect(normalize(s, s, SR, 'stream').gain).toBe(1);
  });
});

describe('compressed export', () => {
  const l = sine(440, 2, 0.5), r = sine(660, 2, 0.5);
  const wasm = (codec: string) => readFileSync(new URL(`../node_modules/wasm-media-encoders/wasm/${codec}.wasm`, import.meta.url));

  it('writes an MP3 a player will recognise', async () => {
    const mp3 = await encodeAudio('mp3', l, r, SR, 1, wasm('mp3'));
    // frame sync, MPEG-1 Layer III
    const sync = mp3.findIndex((b, i) => b === 0xff && (mp3[i + 1] & 0xe0) === 0xe0);
    expect(sync).toBeGreaterThanOrEqual(0);
    expect((mp3[sync + 1] >> 1) & 3).toBe(1);
    // 192 kbit/s for two seconds is about 48 kB
    expect(mp3.length).toBeGreaterThan(40_000);
    expect(mp3.length).toBeLessThan(60_000);
  });

  it('writes an Ogg Vorbis file', async () => {
    const ogg = await encodeAudio('ogg', l, r, SR, 1, wasm('ogg'));
    expect(String.fromCharCode(...ogg.subarray(0, 4))).toBe('OggS');
    expect(String.fromCharCode(...ogg.subarray(29, 35))).toBe('vorbis');
    expect(ogg.length).toBeGreaterThan(5_000);
    expect(ogg.length).toBeLessThan(l.length * 4);
  });

  it('makes bigger files at higher quality, and reports progress', async () => {
    const small = await encodeAudio('mp3', l, r, SR, 0, wasm('mp3'));
    const seen: number[] = [];
    const best = await encodeAudio('mp3', l, r, SR, 2, wasm('mp3'), (d) => { seen.push(d); });
    expect(best.length).toBeGreaterThan(small.length * 1.5);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.length).toBe(2);
  });

  it('copes with nothing to encode', async () => {
    const empty = await encodeAudio('ogg', new Float32Array(0), new Float32Array(0), SR, 1, wasm('ogg'));
    expect(String.fromCharCode(...empty.subarray(0, 4))).toBe('OggS');
  });
});

describe('groups and returns', () => {
  const click = () => { const f = new Float32Array(64); f[0] = 1; return f; };
  function two(): Project {
    const p = emptyProject();
    p.tracks = [newTrack('drum', 0, 'A', 'test/click'), newTrack('drum', 1, 'B', 'test/click')];
    p.patterns = p.patterns.map(() => newPattern(2));
    // quiet hits, so the soft clipper on the master stays out of the sums
    p.patterns[0].steps[0][0] = 70;
    p.patterns[0].steps[1][2] = 70;
    p.fx.compOn = false; p.fx.revLevel = 0; p.fx.dlyLevel = 0;
    return p;
  }
  function render(p: Project, setup?: (e: Engine) => void): { l: Float32Array; e: Engine } {
    const e = new Engine(SR);
    e.setSample('test/click', click());
    e.setProject(p);
    setup?.(e);
    e.play();
    const l = new Float32Array(6000 * 8), r = new Float32Array(6000 * 8);
    for (let pos = 0; pos < l.length; pos += 128) e.process(l, r, Math.min(128, l.length - pos), pos);
    return { l, e };
  }
  const peakAt = (b: Float32Array, step: number) => Math.max(...b.subarray(step * 6000, step * 6000 + 64).map(Math.abs));

  it('a group at unity with no effects changes nothing', () => {
    const plain = render(two()).l;
    const p = two();
    p.buses = [newBus(1)];
    p.tracks[0].bus = 1; p.tracks[1].bus = 1;
    expect(render(p).l).toEqual(plain);
  });

  it('a group fader and mute act on every track sent to it, and only those', () => {
    const p = two();
    p.buses = [newBus(1)];
    p.tracks[0].bus = 1;
    p.buses[0].vol = 50; // a quarter of the level
    const out = render(p).l;
    expect(peakAt(out, 0) / peakAt(out, 2)).toBeCloseTo(0.25, 2);
    p.buses[0].mute = true;
    const muted = render(p).l;
    expect(peakAt(muted, 0)).toBe(0);
    expect(peakAt(muted, 2)).toBeGreaterThan(0.2);
  });

  it('a group effect is heard on its tracks', () => {
    const p = two();
    p.buses = [{ ...newBus(1), fx: [{ type: 'crush', on: true, p: [127, 127, 127, 0] }] }];
    p.tracks[0].bus = 1;
    const dry = render(two()).l, wet = render(p).l;
    expect(wet.subarray(0, 3000)).not.toEqual(dry.subarray(0, 3000));
    expect(wet.subarray(12000, 15000)).toEqual(dry.subarray(12000, 15000));
  });

  it('a track pointing at a group that is not there plays straight to the master', () => {
    const p = two();
    p.tracks[0].bus = 3;
    expect(render(p).l).toEqual(render(two()).l);
    expect(sanitize(JSON.parse(JSON.stringify(p))).tracks[0].bus).toBe(0);
  });

  it('a muted return is silent, and its sends still cost nothing else', () => {
    const p = two();
    p.fx.revLevel = 100;
    p.tracks[0].rev = 127;
    const wet = render(p).l;
    p.fx.revMute = true;
    const dry = render(p).l;
    const tail = (b: Float32Array) => Math.max(...b.subarray(3000, 9000).map(Math.abs));
    expect(tail(wet)).toBeGreaterThan(1e-4);
    expect(tail(dry)).toBe(0);
    expect(peakAt(dry, 0)).toBeCloseTo(peakAt(render(two()).l, 0), 5);
  });

  it('meters every channel, and only when asked to', () => {
    const p = two();
    p.buses = [newBus(1)];
    p.tracks[1].bus = 1;
    p.fx.revLevel = 100; p.tracks[0].rev = 100;
    for (let s = 0; s < 16; s++) { p.patterns[0].steps[0][s] = 127; p.patterns[0].steps[1][s] = 127; }
    const out = new Float32Array(METER_CHANNELS + 2);
    expect(render(p).e.readLoudness(out)).toBe(false);
    const { e } = render(p, (eng) => eng.setMetering(true));
    expect(e.readLoudness(out)).toBe(true);
    expect(out[0]).toBeGreaterThan(-60); // track A
    expect(out[1]).toBeGreaterThan(-60); // track B
    expect(out[2]).toBe(-70); // no third track
    expect(out[8]).toBeCloseTo(out[1], 1); // the group carries only track B
    expect(out[12]).toBeGreaterThan(-70); // reverb return
    expect(out[13]).toBe(-70); // delay return: nothing sent
    expect(out[METER_CHANNELS - 1]).toBeGreaterThan(out[0]); // master: both together
    expect(e.busPeaks[0]).toBeGreaterThan(0.2);
    expect(e.retPeaks[0]).toBeGreaterThan(0);
  });

  it('travels in a link and through a project file, and costs nothing when unused', () => {
    const p = emptyProject();
    const empty = encodeBeat(p).length;
    p.buses = [{ name: 'DRUMS', vol: 87, mute: true, fx: [{ type: 'eq', on: false, p: [1, 2, 3, 4] }, { type: 'drive', on: true, p: [9, 8, 7, 6] }] }, newBus(2)];
    p.tracks[0].bus = 1; p.tracks[3].bus = 2; p.tracks[7].bus = 1;
    p.fx.dlyMute = true;
    expect(plain(decodeBeat(encodeBeat(p))!)).toEqual(plain(p));
    expect(plain(sanitize(JSON.parse(JSON.stringify(p))))).toEqual(plain(p));
    expect(encodeBeat(emptyProject()).length).toBe(empty);
    const old: any = JSON.parse(JSON.stringify(emptyProject()));
    delete old.buses; delete old.fx.revMute; delete old.fx.dlyMute;
    for (const t of old.tracks) delete t.bus;
    expect(plain(sanitize(old))).toEqual(plain(emptyProject()));
  });

  it('keeps no more groups than it should, whatever a file says', () => {
    const raw: any = JSON.parse(JSON.stringify(emptyProject()));
    raw.buses = Array.from({ length: 9 }, () => ({ name: 5, vol: 999, fx: 'x' }));
    raw.tracks[0].bus = 99;
    const p = sanitize(raw);
    expect(p.buses.length).toBe(4);
    expect(p.buses[2]).toEqual({ name: 'GROUP 3', vol: 127, mute: false, fx: [] });
    expect(p.tracks[0].bus).toBe(4);
  });
});
