import { describe, expect, it } from 'vitest';
import { compileCode, type CodeInfo } from '../src/core/mini';

const info: CodeInfo = {
  tracks: [
    { name: 'KICK', kind: 'drum', note: 48 }, { name: 'HAT', kind: 'dsyn', note: 48 },
    { name: 'LEAD', kind: 'synth', note: 60 }, { name: 'CHOP', kind: 'slice', note: 0 }, { name: 'BASS', kind: 'bass', note: 36 },
  ],
  scaleRoot: 0, scaleType: 1, // C minor
};
const one = (src: string) => compileCode(src, info)[0];
const times = (src: string, cyc = 0) => [...one(src).cycles[cyc].t].map((x) => +x.toFixed(4));
const pitches = (src: string, cyc = 0) => [...one(src).cycles[cyc].p];

describe('mini-notation', () => {
  it('shares the bar out between the things in it', () => {
    expect(times('kick: x ~ x ~')).toEqual([0, 0.5]);
    expect(times('kick: x x x')).toEqual([0, 0.3333, 0.6667]);
    expect(times('kick: x x x x x x x x x x x x x x x x')).toEqual(Array.from({ length: 16 }, (_, i) => i / 16));
  });

  it('groups with brackets', () => {
    expect(times('kick: [x x] x')).toEqual([0, 0.25, 0.5]);
    expect(times('kick: x [x [x x]]')).toEqual([0, 0.5, 0.75, 0.875]);
  });

  it('speeds up and slows down', () => {
    expect(times('kick: x*4')).toEqual([0, 0.25, 0.5, 0.75]);
    expect(times('kick: [x ~ x]*2')).toEqual([0, 0.3333, 0.5, 0.8333]);
    const slow = one('kick: [x y]/2');
    expect(slow.cycles.length).toBe(2);
    expect([...slow.cycles[0].t]).toEqual([0]);
    expect([...slow.cycles[1].t]).toEqual([0]);
    expect(slow.cycles[0].d[0]).toBe(1);
    expect(times('kick: x*1.5')).toEqual([0, 0.6667]);
    expect(times('kick: x*1.5', 1)).toEqual([0.3333]);
  });

  it('holds, repeats and weighs', () => {
    expect(times('kick: x@3 x')).toEqual([0, 0.75]);
    expect(times('kick: x _ _ x')).toEqual([0, 0.75]);
    expect(one('kick: x _ _ x').cycles[0].d[0]).toBe(0.75);
    expect(times('kick: x!3 x')).toEqual([0, 0.25, 0.5, 0.75]);
    expect(times('kick: x ! ! ~')).toEqual([0, 0.25, 0.5]);
  });

  it('takes turns inside < >', () => {
    const l = one('lead: <c4 eb4 g4>');
    expect(l.cycles.length).toBe(3);
    expect(l.cycles.map((c) => c.p[0])).toEqual([60, 63, 67]);
    expect(pitches('lead: c4 <e4 g4>', 1)).toEqual([60, 67]);
    // sped up, the turns are taken within the bar
    expect(pitches('lead: <c4 e4>*2')).toEqual([60, 64]);
    expect(one('lead: <c4 e4> <c4 e4 g4>').cycles.length).toBe(6);
  });

  it('spreads hits evenly with (hits,steps)', () => {
    expect(times('kick: x(3,8)')).toEqual([0, 0.375, 0.75]);
    expect(times('kick: x(3,8,2)')).toEqual([0.125, 0.5, 0.75].sort());
    expect(times('kick: x(4,4)')).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('plays things together with commas', () => {
    expect(pitches('lead: [c4,eb4,g4]')).toEqual([60, 63, 67]);
    expect(times('lead: [c4,eb4,g4]')).toEqual([0, 0, 0]);
    expect(times('kick: x ~ ~ ~, ~ ~ x ~')).toEqual([0, 0.5]);
  });

  it('drops hits by chance, the same way every time', () => {
    const a = compileCode('kick: x*8?', info)[0], b = compileCode('kick: x*8?', info)[0];
    expect(a.cycles.length).toBe(16);
    const counts = a.cycles.map((c) => c.t.length);
    expect(counts.some((n) => n < 8)).toBe(true);
    expect(counts.some((n) => n > 0)).toBe(true);
    expect(counts).toEqual(b.cycles.map((c) => c.t.length));
    const total = counts.reduce((s, n) => s + n, 0);
    expect(total).toBeGreaterThan(8 * 16 * 0.3);
    expect(total).toBeLessThan(8 * 16 * 0.7);
    expect(one('kick: x?0').cycles.every((c) => c.t.length === 1)).toBe(true);
    expect(one('kick: x?1').cycles.every((c) => c.t.length === 0)).toBe(true);
    const pick = one('lead: c4|e4|g4');
    expect(new Set(pick.cycles.map((c) => c.p[0])).size).toBeGreaterThan(1);
  });

  it('reads words as each kind of track means them', () => {
    expect([...one('kick: x X bd').cycles[0].v]).toEqual([100, 127, 100]);
    expect(pitches('lead: c4 eb4 f#3 bb2 e')).toEqual([60, 63, 54, 46, 64]);
    // numbers are steps of the song's scale from the track's own note
    expect(pitches('lead: 0 1 2 7 -1')).toEqual([60, 62, 63, 72, 58]);
    expect(pitches('bass: 0 4')).toEqual([36, 43]);
    expect(pitches('chop: 0 3 7')).toEqual([0, 3, 7]);
    expect(pitches('3: c4')).toEqual([60]);
    expect(one('3: c4').track).toBe(2);
    expect(one('Lead: c4').track).toBe(2);
  });

  it('ignores comments and blank lines, and keeps the line numbers', () => {
    const lines = compileCode('// drums\nkick: x ~ // four on the floor\n\nhat: x*8', info);
    expect(lines.map((l) => [l.line, l.track])).toEqual([[1, 0], [3, 1]]);
    expect(lines[0].cycles[0].t.length).toBe(1);
  });

  it('says what is wrong and where', () => {
    const e = (src: string) => one(src).error!;
    expect(e('kick: x [x x').message).toContain('"]" is missing');
    expect(e('kick: x ] x').message).toContain('unexpected "]"');
    expect(e('kick: x ] x').col).toBe(8);
    expect(e('snare: x').message).toContain('no track called "snare"');
    expect(e('just words').message).toContain('track: pattern');
    expect(e('lead: c4 h4').message).toContain('"h4" is not a note');
    expect(e('lead: c4 h4').col).toBe(9);
    expect(e('chop: c4').message).toContain('slice number');
    expect(e('kick: x*').message).toContain('number is needed');
    expect(e('kick: x(9,8)').message).toContain('outnumber');
    expect(e('kick: x(3)').message).toContain('(hits,steps)');
    expect(e('kick: _ x').message).toContain('nothing before it');
    expect(e('kick: x*100').message).toContain('between 0 and 64');
    expect(e(`kick: ${'[x*64]*8'}`).message).toContain('256 is the most');
  });

  it('keeps playing what a line had before a mistake was typed into it', () => {
    const good = compileCode('kick: x ~ x ~\nhat: x*4', info);
    const broken = compileCode('kick: x ~ x [\nhat: x*8', info, good);
    expect(broken[0].error).toBeDefined();
    expect([...broken[0].cycles[0].t]).toEqual([0, 0.5]);
    expect(broken[1].error).toBeUndefined();
    expect(broken[1].cycles[0].t.length).toBe(8);
    // and nothing, if it never worked
    expect(compileCode('kick: [', info)[0].cycles).toEqual([]);
  });

  it('never throws, whatever is typed', () => {
    for (const junk of ['', ':', '::::', 'kick:', 'kick: ', 'kick: <>', 'kick: []', 'kick: [[[[', 'kick: >>>', 'kick: x@0', 'kick: x/0', 'kick: x!0', 'kick: (3,8)', 'kick: ~*4', 'kick: x?x', 'kick: ,,,', 'kick: |', '9: x', 'kick: x\u0000y', 'kick: ' + 'x '.repeat(3000)])
      expect(() => compileCode(junk, info)).not.toThrow();
    expect(one('kick: <>').cycles[0].t.length).toBe(0);
    expect(one('kick:').cycles[0].t.length).toBe(0);
  });
});

import { renderProject } from '../src/core/render';
import { decodeBeat, encodeBeat } from '../src/core/share';
import { TEMPLATES } from '../src/core/templates';
import { emptyProject, newPattern, newTrack, sanitize, type Project } from '../src/core/types';
import { codeInfo, gridAsCode } from '../src/core/mini';

const SR = 48000;
function blank(code: string): Project {
  const p = emptyProject();
  p.bpm = 120; // a step is 6000 frames, a bar 96000
  p.tracks = [newTrack('drum', 0, 'KICK', 'test/click'), newTrack('plugin', 1, 'LEAD')];
  p.tracks[1].plugins = [{ url: 'plugins/pluck/index.js', name: 'Pluck', state: '' }];
  p.patterns = p.patterns.map(() => newPattern(2));
  p.code = code;
  return sanitize(p);
}
// a click one sample long, so every hit shows up as a single spike
const click = new Float32Array(64);
click[0] = 1;
const bank = { 'test/click': { l: click } };
function spikes(x: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.02 && (i === 0 || Math.abs(x[i - 1]) < 0.002)) out.push(i);
  return out;
}

describe('live code in the engine', () => {
  it('plays its hits on their exact frames, between the steps too', async () => {
    const out = await renderProject(blank('kick: x x x'), bank, { sampleRate: SR, chain: [0] });
    expect(spikes(out.l)).toEqual([0, 32000, 64000]);
    const five = await renderProject(blank('kick: x*5'), bank, { sampleRate: SR, chain: [0] });
    expect(spikes(five.l)).toEqual([0, 19200, 38400, 57600, 76800]);
  });

  it('plays along with the grid, and stops when switched off', async () => {
    const p = blank('kick: ~ x');
    p.patterns[0].steps[0][0] = 100;
    expect(spikes((await renderProject(p, bank, { sampleRate: SR, chain: [0] })).l)).toEqual([0, 48000]);
    p.codeOn = false;
    expect(spikes((await renderProject(p, bank, { sampleRate: SR, chain: [0] })).l)).toEqual([0]);
  });

  it('moves on a turn each bar', async () => {
    const out = await renderProject(blank('kick: <x [x x] [x x x x]>'), bank, { sampleRate: SR, chain: [0, 0, 0] });
    expect(spikes(out.l)).toEqual([0, 96000, 144000, 192000, 216000, 240000, 264000]);
  });

  it('follows the bars of the song', async () => {
    const p = blank('kick: <x [x x]>');
    p.songMode = true;
    p.arr.clips = [{ id: 'a', track: 0, pattern: 1, start: 0, len: 32, offset: 0 }];
    const out = await renderProject(sanitize(p), bank, { sampleRate: SR });
    expect(spikes(out.l).slice(0, 3)).toEqual([0, 96000, 144000]);
  });

  it('sends notes, with their lengths, to whatever plays the track', async () => {
    const seen: [boolean, number, number][] = [];
    await renderProject(blank('lead: c4 _ e4 ~'), bank, { sampleRate: SR, chain: [0], onPlug: (_t, on, pitch, _v, frame) => seen.push([on, pitch, frame]) });
    expect(seen.filter((e) => e[0])).toEqual([[true, 60, 0], [true, 64, 48000]]);
    const off = seen.filter((e) => !e[0] && e[1] >= 0);
    expect(off[0][1]).toBe(60);
    expect(off[0][2]).toBeGreaterThan(40000);
    expect(off[0][2]).toBeLessThanOrEqual(48000);
  });

  it('carries on with the last working version of a line', async () => {
    const { Engine } = await import('../src/core/engine');
    const e = new Engine(SR);
    for (const id in bank) e.setSample(id, bank[id as keyof typeof bank].l);
    e.setProject(blank('kick: x x'));
    e.setProject(blank('kick: x x ['));
    e.play({ chain: [0], loop: false });
    const l = new Float32Array(96000), r = new Float32Array(96000);
    e.process(l, r, 96000);
    expect(spikes(l)).toEqual([0, 48000]);
  });
});

describe('code in files and links', () => {
  it('travels in a share link', () => {
    const p = blank('kick: x ~ x ~\n// ünïcödé too\nlead: <c4 e4>');
    p.codeOn = false;
    const back = decodeBeat(encodeBeat(p))!;
    expect(back.code).toBe(p.code);
    expect(back.codeOn).toBe(false);
    const none = decodeBeat(encodeBeat(blank('')))!;
    expect(none.code).toBe('');
    expect(none.codeOn).toBe(true);
  });

  it('leaves links without code as they were', () => {
    const a = TEMPLATES[0].make();
    const b = TEMPLATES[0].make();
    b.code = '   \n';
    expect(encodeBeat(a)).toBe(encodeBeat(b));
  });
});

describe('the grid as code', () => {
  it('writes every template out as code that plays the same hits', () => {
    for (const tpl of TEMPLATES) {
      const p = sanitize(tpl.make());
      const text = gridAsCode(p, 0);
      const lines = compileCode(text, codeInfo(p));
      expect(lines.some((l) => l.error)).toBe(false);
      for (const l of lines) {
        const tr = p.tracks[l.track], c = l.cycles[0];
        const got = [...c.t].map((t, i) => `${Math.round(t * p.steps)}:${tr.kind === 'drum' || tr.kind === 'dsyn' ? 'x' : c.p[i]}`).sort();
        const pat = p.patterns[0];
        const want = (tr.kind === 'drum' || tr.kind === 'dsyn'
          ? pat.steps[l.track].slice(0, p.steps).flatMap((v, s) => (v ? [`${s}:x`] : []))
          : pat.notes[l.track].filter((n) => n.s < p.steps).map((n) => `${n.s}:${n.p}`)).sort();
        expect(got, `${tpl.name} ${tr.name}`).toEqual(want);
      }
    }
  });
});
