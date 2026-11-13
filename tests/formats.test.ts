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

describe('genre templates', () => {
  it('are valid beats that survive a link and a save untouched', async () => {
    const { TEMPLATES } = await import('../src/core/templates');
    const { decodeBeat, encodeBeat } = await import('../src/core/share');
    const { plain } = await import('./helpers');
    expect(TEMPLATES.map((t) => t.id)).toEqual(['trap', 'house', 'boombap', 'lofi', 'drill']);
    for (const t of TEMPLATES) {
      const p = t.make();
      expect(plain(sanitize(JSON.parse(JSON.stringify(p)))), t.name).toEqual(plain(p));
      expect(plain(decodeBeat(encodeBeat(p))!), t.name).toEqual(plain(p));
      expect(p.bpm).toBe(t.bpm);
      // the kit it says it uses is the one on its drum tracks
      expect(p.tracks.filter((x) => x.kind === 'drum').every((x) => x.sample.startsWith(`${t.kit}/`)), t.name).toBe(true);
      // two patterns to work with, and every note in the key it sets
      expect(p.patterns[0].steps[0].some((v) => v > 0) && p.patterns[1].steps[0].some((v) => v > 0)).toBe(true);
      for (const pat of p.patterns) for (const n of [...pat.notes[6], ...pat.notes[7]]) expect(inScale(n.p, p.scaleRoot, p.scaleType), `${t.name}: note ${n.p}`).toBe(true);
    }
  });

  it('render without clipping or silence', async () => {
    const { TEMPLATES } = await import('../src/core/templates');
    const { renderProject } = await import('../src/core/render');
    for (const t of TEMPLATES) {
      const p = t.make();
      const bank: Record<string, { l: Float32Array }> = {};
      const hit = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i * 0.05) * Math.exp(-i / 500));
      for (const tr of p.tracks) bank[tr.sample] = { l: hit };
      const out = await renderProject(p, bank, { sampleRate: 44100, chain: [0, 1], maxTail: 0.5 });
      let peak = 0, sum = 0;
      for (let i = 0; i < out.l.length; i++) { peak = Math.max(peak, Math.abs(out.l[i])); sum += out.l[i] * out.l[i]; }
      expect(peak, t.name).toBeLessThanOrEqual(1);
      expect(Math.sqrt(sum / out.l.length), t.name).toBeGreaterThan(0.02);
    }
  });
});

describe('project file versions', () => {
  it('writes version 3 and still opens a version 2 file as the beat it was', async () => {
    const { zipSync, unzipSync, strToU8, strFromU8 } = await import('fflate');
    const { FILE_VERSION } = await import('../src/core/projectfile');
    const { plain } = await import('./helpers');
    const p = emptyProject();
    p.name = 'three';
    p.tracks[6].kind = 'bass';
    p.buses = [{ name: 'DRUMS', vol: 90, mute: false, fx: [] }];
    p.tracks[0].bus = 1;
    p.patterns[0].mods[0][0] = 99;
    const file = packProjectFile(p, []);
    const manifest = JSON.parse(strFromU8(unzipSync(file)['project.json']));
    expect(FILE_VERSION).toBe(3);
    expect(manifest.version).toBe(3);
    expect(plain(unpackProjectFile(file).project)).toEqual(plain(p));

    // a file as 2.0 wrote it: version 2, and none of the fields added since
    const old: any = JSON.parse(JSON.stringify(emptyProject()));
    old.name = 'two';
    old.bpm = 101;
    delete old.buses; delete old.groove; delete old.grooveAmt; delete old.fx.revMute; delete old.fx.dlyMute;
    for (const t of old.tracks) for (const k of ['bass', 'dsyn', 'bus', 'groove', 'grooveAmt', 'arpMode', 'arpRate', 'arpOct', 'arpGate']) delete t[k];
    for (const pat of old.patterns) delete pat.mods;
    old.patterns[0].steps[0][0] = 100;
    const v2 = zipSync({ 'project.json': strToU8(JSON.stringify({ format: 'loopwell', version: 2, project: old, samples: [] })) });
    const want = emptyProject();
    want.name = 'two'; want.bpm = 101; want.patterns[0].steps[0][0] = 100;
    expect(plain(unpackProjectFile(v2).project)).toEqual(plain(want));
  });

  it('opens a file from a version that does not exist yet, keeping what it understands', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const future: any = JSON.parse(JSON.stringify(emptyProject()));
    future.bpm = 133;
    future.somethingNew = { a: 1 };
    future.tracks[0].kind = 'hologram';
    const file = zipSync({ 'project.json': strToU8(JSON.stringify({ format: 'loopwell', version: 9, project: future, samples: [] })) });
    const p = unpackProjectFile(file).project;
    expect(p.bpm).toBe(133);
    expect(p.tracks[0].kind).toBe('drum');
    expect('somethingNew' in p).toBe(false);
  });
});
