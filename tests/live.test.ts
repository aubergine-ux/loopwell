import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEMOS } from '../src/core/demos';
import { emptyProject, newId, newInsert, sanitize, type Project } from '../src/core/types';
import { describeChange, fromY, patchInto, toY } from '../src/live/ydoc';
import { stressProject } from './realtime/stress';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ids = (p: Project) => p.tracks.map((_, i) => `t${i}`);

/** What the document holds, as a clean project, with the per-person bits evened out. */
function read(doc: Y.Doc): Project {
  const p = sanitize(fromY(doc)!.project);
  p.arr.clips.sort((a, b) => a.start - b.start || a.track - b.track);
  for (const c of p.arr.clips) c.id = '';
  for (const l of p.arr.lanes) l.id = '';
  return p;
}
function norm(p: Project): Project {
  const c = clone(p);
  c.songMode = false; // which view someone is in is not shared
  c.arr.clips.sort((a, b) => a.start - b.start || a.track - b.track);
  for (const x of c.arr.clips) x.id = '';
  c.arr.lanes.sort((a, b) => a.track - b.track || (a.param < b.param ? -1 : 1));
  for (const l of c.arr.lanes) l.id = '';
  for (const pat of c.patterns) for (const n of pat.notes) n.sort((a, b) => a.s - b.s || a.p - b.p);
  return c;
}

/** Two people on the same beat, with a wire between them that can be cut. */
function pair(p: Project) {
  const a = new Y.Doc(), b = new Y.Doc();
  toY(a, p, ids(p));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); };
  return { a, b, sync };
}

describe('the shared document', () => {
  it('holds a whole beat and gives it back unchanged', () => {
    const fx = DEMOS[0].make();
    fx.tracks[2].fx = [newInsert('eq'), newInsert('duck')];
    fx.tracks[0].kind = 'slice'; fx.tracks[0].slices = [0, 9000, 30000];
    fx.arr.lanes.push({ id: 'x', track: 0, param: 'vol', on: true, points: [{ t: 0, v: 10 }, { t: 9, v: 90 }] },
      { id: 'y', track: -1, param: 'mfilter', on: false, points: [{ t: 4, v: -20 }] });
    fx.arr.markers.push({ at: 16, name: 'hook', color: 3 });
    fx.arr.tempo.push({ at: 32, bpm: 99 });
    fx.arr.sigs.push({ at: 0, num: 3, den: 4 });
    fx.arr.loopOn = true; fx.arr.loopEnd = 64;
    for (const p of [emptyProject(), fx, ...DEMOS.map((d) => d.make()), stressProject()]) {
      const doc = new Y.Doc();
      toY(doc, p, ids(p));
      expect(read(doc), p.name).toEqual(norm(sanitize(clone(p))));
      expect(fromY(doc)!.trackIds).toEqual(ids(p));
    }
    expect(fromY(new Y.Doc())).toBeNull();
  });

  it('writes only what changed', () => {
    const p = DEMOS[1].make();
    const doc = new Y.Doc();
    toY(doc, p, ids(p));
    const sizes: number[] = [];
    doc.on('update', (u: Uint8Array) => sizes.push(u.length));
    toY(doc, p, ids(p));
    expect(sizes).toEqual([]); // nothing changed, nothing sent
    p.patterns[0].steps[1][5] = 100;
    toY(doc, p, ids(p));
    p.tracks[3].vol = 64;
    toY(doc, p, ids(p));
    p.patterns[2].notes[6].push({ s: 3, l: 2, p: 50, v: 90 });
    toY(doc, p, ids(p));
    expect(sizes.length).toBe(3);
    for (const s of sizes) expect(s).toBeLessThan(80); // one step, one knob, one note: a few dozen bytes each
  });

  it('merges what two people do at the same moment', () => {
    const p = emptyProject();
    const { a, b, sync } = pair(p);
    const pa = clone(p), pb = clone(p);
    pa.patterns[0].steps[0][0] = 127;
    pa.patterns[0].steps[0][8] = 90;
    pa.tracks[0].vol = 50;
    pa.bpm = 140;
    pa.patterns[0].notes[6].push({ s: 0, l: 4, p: 36, v: 100 });
    pb.patterns[0].steps[0][4] = 110; // same row, another step
    pb.patterns[0].steps[1][4] = 100;
    pb.tracks[0].pan = -20; // same track, another knob
    pb.swing = 30;
    pb.patterns[0].notes[6].push({ s: 8, l: 2, p: 43, v: 80 });
    pb.arr.markers.push({ at: 16, name: 'drop', color: 1 });
    toY(a, pa, ids(p));
    toY(b, pb, ids(p));
    sync();
    const got = read(a);
    expect(read(b)).toEqual(got);
    expect(got.patterns[0].steps[0].slice(0, 9)).toEqual([127, 0, 0, 0, 110, 0, 0, 0, 90]);
    expect(got.patterns[0].steps[1][4]).toBe(100);
    expect([got.tracks[0].vol, got.tracks[0].pan, got.bpm, got.swing]).toEqual([50, -20, 140, 30]);
    expect(got.patterns[0].notes[6].map((n) => n.p)).toEqual([36, 43]);
    expect(got.arr.markers).toEqual([{ at: 16, name: 'drop', color: 1 }]);
  });

  it('settles on one value when two people turn the same knob', () => {
    const p = emptyProject();
    const { a, b, sync } = pair(p);
    const pa = clone(p), pb = clone(p);
    pa.tracks[2].vol = 10; pb.tracks[2].vol = 120;
    pa.patterns[0].steps[2][3] = 40; pb.patterns[0].steps[2][3] = 99;
    toY(a, pa, ids(p));
    toY(b, pb, ids(p));
    sync();
    expect(read(a)).toEqual(read(b));
    expect([10, 120]).toContain(read(a).tracks[2].vol);
    expect([40, 99]).toContain(read(a).patterns[0].steps[2][3]);
  });

  it('keeps everyone\'s work straight when tracks are added and removed', () => {
    const p = emptyProject();
    const { a, b, sync } = pair(p);
    // A deletes track 2 (CLAP) while B, not knowing, writes steps on track 5 (PERC) and track 2
    const pa = clone(p);
    pa.tracks.splice(2, 1);
    for (const pat of pa.patterns) { pat.steps.splice(2, 1); pat.notes.splice(2, 1); pat.mods.splice(2, 1); }
    pa.arr.clips = pa.arr.clips.filter((c) => c.track !== 2).map((c) => ({ ...c, track: c.track > 2 ? c.track - 1 : c.track }));
    const idsA = ids(p).filter((_, i) => i !== 2);
    const pb = clone(p);
    pb.patterns[0].steps[5][7] = 111;
    pb.patterns[0].steps[2][1] = 99;
    toY(a, pa, idsA);
    toY(b, pb, ids(p));
    sync();
    const got = read(a);
    expect(read(b)).toEqual(got);
    expect(got.tracks.map((t) => t.name)).toEqual(['KICK', 'SNARE', 'HAT', 'OPEN', 'PERC', 'BASS', 'LEAD']);
    expect(got.patterns[0].steps[4][7]).toBe(111); // PERC kept B's hit, now one row up
    expect(got.patterns[0].steps.flat().filter((v) => v > 0)).toEqual([111]); // and the deleted track's hit went with it
    expect(fromY(a)!.trackIds).toEqual(idsA);

    // both add a track at the same moment on a beat that has room for one more: both arrive, the limit still holds
    const seven = read(a);
    const add = (name: string) => {
      const q = clone(seven);
      q.tracks.push({ ...clone(q.tracks[0]), name });
      for (const pat of q.patterns) { pat.steps.push(new Array(32).fill(0)); pat.notes.push([]); pat.mods.push(new Array(32).fill(0)); }
      return q;
    };
    toY(a, add('A-NEW'), [...idsA, 'na']);
    toY(b, add('B-NEW'), [...idsA, 'nb']);
    sync();
    const eight = read(a);
    expect(read(b)).toEqual(eight);
    expect(eight.tracks.length).toBe(8);
    expect(['A-NEW', 'B-NEW']).toContain(eight.tracks[7].name);
  });

  it('survives a disconnect: both sides keep editing and nothing is lost', () => {
    const p = DEMOS[0].make();
    const { a, b, sync } = pair(p);
    let pa = clone(p), pb = clone(p);
    for (let i = 0; i < 20; i++) {
      pa.patterns[0].steps[0][i % 16] = 60 + i; toY(a, pa, ids(p));
      pb.patterns[1].steps[3][(i * 3) % 16] = 70 + i; toY(b, pb, ids(p));
      pb.arr.clips[i % pb.arr.clips.length].len = 16 + i; toY(b, pb, ids(p));
    }
    pa.arr.clips.push({ id: newId(), track: 0, pattern: 3, start: 512, len: 16, offset: 0 });
    toY(a, pa, ids(p));
    sync();
    const got = read(a);
    expect(read(b)).toEqual(got);
    expect(got.patterns[0].steps[0]).toEqual(pa.patterns[0].steps[0]);
    expect(got.patterns[1].steps[3]).toEqual(pb.patterns[1].steps[3]);
    expect(got.arr.clips.some((c) => c.start === 512 && c.pattern === 3)).toBe(true);
    expect(got.arr.clips.length).toBe(p.arr.clips.length + 1);
  });
});

describe('applying someone else\'s edit to the app', () => {
  it('changes only what differs and leaves everything else alone', () => {
    const p = DEMOS[0].make();
    const before = { track: p.tracks[3], row: p.patterns[0].steps[2], pattern: p.patterns[4], fx: p.fx };
    const next = clone(p);
    next.tracks[1].vol = 77;
    next.patterns[0].steps[0][3] = 55;
    next.patterns[1].notes[6].push({ s: 1, l: 1, p: 40, v: 99 });
    next.tracks.pop();
    for (const pat of next.patterns) { pat.steps.pop(); pat.notes.pop(); }
    next.arr.clips = next.arr.clips.filter((c) => c.track < 7);
    patchInto(p, next);
    expect(p).toEqual(next);
    // objects that didn't change are the very same objects, so nothing that shows them needs to redraw
    expect(p.tracks[3]).toBe(before.track);
    expect(p.patterns[0].steps[2]).toBe(before.row);
    expect(p.patterns[4]).toBe(before.pattern);
    expect(p.fx).toBe(before.fx);
  });
});

describe('the activity log', () => {
  it('says what changed in a few words', () => {
    const p = emptyProject();
    const edit = (fn: (q: Project) => void) => { const q = clone(p); fn(q); return describeChange(p, q); };
    expect(edit(() => {})).toBe('');
    expect(edit((q) => { q.songMode = true; })).toBe('');
    expect(edit((q) => { q.bpm = 132; })).toBe('tempo 120 → 132');
    expect(edit((q) => { q.patterns[1].steps[0][4] = 100; })).toBe('KICK: pattern B');
    expect(edit((q) => { q.tracks[6].synth.cutoff = 3; })).toBe('BASS: sound');
    expect(edit((q) => { q.tracks[3].mute = true; })).toBe('muted HAT');
    expect(edit((q) => { q.tracks[3].vol = 3; q.tracks[3].pan = 9; })).toBe('HAT: mix');
    expect(edit((q) => { q.tracks[2].fx.push(newInsert('drive')); })).toBe('CLAP: effects');
    expect(edit((q) => { q.arr.clips[0].start = 16; })).toBe('the arrangement');
    expect(edit((q) => { q.fx.revSize = 1; q.arr.markers.push({ at: 0, name: 'a', color: 0 }); })).toBe('master effects, markers');
    expect(edit((q) => { q.bpm = 90; q.swing = 9; q.master = 3; q.name = 'x'; q.steps = 32; })).toMatch(/^tempo 120 → 90, swing, renamed the beat “x” and 2 more$/);
  });
});
