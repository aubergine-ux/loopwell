import { describe, expect, it } from 'vitest';
import { DEMOS } from '../src/core/demos';
import { exportMidi } from '../src/core/midi';
import { packProjectFile, unpackProjectFile } from '../src/core/projectfile';
import { degreeToPitch, inScale, scalePitches, snapToScale } from '../src/core/scales';
import { emptyProject, sanitize } from '../src/core/types';
import { decodeWav, encodeWav } from '../src/core/wav';

/** Tiny SMF reader: returns note-on [tick, channel, note, velocity] per track. */
function readMidi(b: Uint8Array) {
  const u32 = (o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  expect(String.fromCharCode(...b.subarray(0, 4))).toBe('MThd');
  const ntracks = (b[10] << 8) | b[11], ppq = (b[12] << 8) | b[13];
  const tracks: number[][][] = [];
  let tempo = 0, o = 14;
  for (let t = 0; t < ntracks; t++) {
    expect(String.fromCharCode(...b.subarray(o, o + 4))).toBe('MTrk');
    const end = o + 8 + u32(o + 4);
    o += 8;
    let tick = 0;
    const ons: number[][] = [];
    while (o < end) {
      let d = 0, c: number;
      do { c = b[o++]; d = (d << 7) | (c & 127); } while (c & 128);
      tick += d;
      const st = b[o++];
      if (st === 0xff) {
        const type = b[o++], len = b[o++];
        if (type === 0x51) tempo = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
        o += len;
      } else {
        if ((st & 0xf0) === 0x90) ons.push([tick, st & 15, b[o], b[o + 1]]);
        o += 2;
      }
    }
    expect(o).toBe(end);
    tracks.push(ons);
  }
  expect(o).toBe(b.length);
  return { ntracks, ppq, tempo, tracks };
}

describe('MIDI export', () => {
  it('writes a valid file with tempo, drums on channel 10 and swing', () => {
    const p = emptyProject();
    p.bpm = 100; p.swing = 100;
    p.patterns[0].steps[0][0] = 127;
    p.patterns[0].steps[0][5] = 80;
    p.patterns[0].notes[6] = [{ s: 2, l: 4, p: 45, v: 99 }];
    const m = readMidi(exportMidi(p, [0, 0]));
    expect(m.ppq).toBe(96);
    expect(m.tempo).toBe(600000);
    expect(m.ntracks).toBe(3); // tempo track + the two tracks that have notes
    expect(m.tracks[1]).toEqual([[0, 9, 36, 127], [5 * 24 + 12, 9, 36, 80], [384, 9, 36, 127], [384 + 132, 9, 36, 80]]);
    expect(m.tracks[2]).toEqual([[48, 0, 45, 99], [384 + 48, 0, 45, 99]]);
  });

  it('exports every demo without error', () => {
    for (const d of DEMOS) {
      const p = d.make();
      const m = readMidi(exportMidi(p));
      expect(m.ntracks).toBeGreaterThan(4);
    }
  });

  it('handles an empty project', () => {
    expect(readMidi(exportMidi(emptyProject(), [0])).ntracks).toBe(1);
  });
});

describe('project files', () => {
  it('round-trips the project and only the samples it uses', () => {
    const p = DEMOS[1].make();
    p.tracks[0].sample = 'user/aaaa';
    const a = { id: 'user/aaaa', name: 'kick.wav', bytes: new Uint8Array([1, 2, 3, 250]) };
    const b = { id: 'user/unused', name: 'nope.wav', bytes: new Uint8Array([9]) };
    const out = unpackProjectFile(packProjectFile(p, [a, b]));
    expect(out.project).toEqual(p);
    expect(out.samples).toEqual([a]);
  });

  it('rejects files that are not projects', () => {
    expect(() => unpackProjectFile(new Uint8Array([1, 2, 3]))).toThrow(/not a Loopwell project/);
    expect(() => unpackProjectFile(new Uint8Array(0))).toThrow();
  });
});

describe('sanitize', () => {
  it('turns junk into a playable project', () => {
    for (const junk of [null, 42, 'x', {}, { tracks: 'no' }, { tracks: [{}], patterns: [{ steps: [[999, -5, 'a']] }], bpm: 1e9, song: [77] }]) {
      const p = sanitize(junk);
      expect(p.tracks.length).toBeGreaterThan(0);
      expect(p.patterns.length).toBe(8);
      expect(p.bpm).toBeGreaterThanOrEqual(40);
      expect(p.bpm).toBeLessThanOrEqual(240);
      for (const pat of p.patterns) for (const s of pat.steps) {
        expect(s.length).toBe(32);
        for (const v of s) expect(v >= 0 && v <= 127).toBe(true);
      }
      for (const c of p.arr.clips) expect(c.pattern >= 0 && c.pattern < 8 && c.track < p.tracks.length && c.len > 0).toBe(true);
    }
  });

  it('is idempotent', () => {
    for (const d of DEMOS) { const p = d.make(); expect(sanitize(p)).toEqual(p); }
  });
});

describe('scales', () => {
  it('knows what is in key', () => {
    expect(inScale(60, 0, 0)).toBe(true);
    expect(inScale(61, 0, 0)).toBe(false);
    expect(inScale(57, 9, 1)).toBe(true);
    expect(scalePitches(0, 0, 60, 72)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });
  it('snaps wrong notes to the nearest right one', () => {
    expect(snapToScale(61, 0, 0)).toBe(60);
    expect(snapToScale(64, 0, 0)).toBe(64);
    for (let p = 0; p < 128; p++) expect(inScale(snapToScale(p, 3, 5), 3, 5)).toBe(true);
  });
  it('walks scale degrees across octaves', () => {
    expect([0, 1, 2, 7, -1].map((d) => degreeToPitch(9, 1, 57, d))).toEqual([57, 59, 60, 69, 55]);
  });
});

describe('WAV', () => {
  it('round-trips 16 and 24 bit audio', () => {
    const l = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) * 0.8);
    const r = Float32Array.from({ length: 500 }, (_, i) => Math.cos(i / 5) * 0.5);
    for (const bits of [16, 24] as const) {
      const w = decodeWav(encodeWav([l, r], 48000, bits));
      expect(w.sampleRate).toBe(48000);
      expect(w.channels.length).toBe(2);
      const tol = bits === 16 ? 1 / 16000 : 1 / 4000000;
      for (let i = 0; i < 500; i++) {
        expect(Math.abs(w.channels[0][i] - l[i])).toBeLessThan(tol);
        expect(Math.abs(w.channels[1][i] - r[i])).toBeLessThan(tol);
      }
    }
  });
  it('clips instead of wrapping', () => {
    const w = decodeWav(encodeWav([new Float32Array([2, -2])], 44100, 16));
    expect(w.channels[0][0]).toBeGreaterThan(0.99);
    expect(w.channels[0][1]).toBeLessThan(-0.99);
  });
});
