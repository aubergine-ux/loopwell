import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { renderProject } from '../src/core/render';
import { decodeBeat, encodeBeat } from '../src/core/share';
import { emptyProject, newPattern, newTrack, pluginUrlOk, sanitize, type Project } from '../src/core/types';

const SR = 48000;

function song(): Project {
  const p = emptyProject();
  p.bpm = 120;
  p.tracks = [newTrack('drum', 0, 'KICK', 'test/click'), newTrack('plugin', 1, 'HARP')];
  p.tracks[1].plugins = [{ url: 'plugins/pluck/index.js', name: 'Pluck', state: '{"parameterValues":{"decay":{"id":"decay","value":4,"normalized":false}}}' }];
  p.patterns = p.patterns.map(() => newPattern(2));
  p.patterns[0].steps[0][0] = 100;
  p.patterns[0].notes[1] = [{ s: 0, l: 2, p: 60, v: 100 }, { s: 4, l: 1, p: 64, v: 90 }, { s: 8, l: 4, p: 67, v: 80 }];
  return sanitize(p);
}

describe('plugin tracks', () => {
  it('survive a share link, settings included', () => {
    const p = song();
    const back = decodeBeat(encodeBeat(p))!;
    expect(back.tracks[1].kind).toBe('plugin');
    expect(back.tracks[1].plugins).toEqual(p.tracks[1].plugins);
    expect(back.patterns[0].notes[1]).toEqual(p.patterns[0].notes[1]);
    expect(back.tracks[0].kind).toBe('drum');
  });

  it('keep several plugins in order, and leave oversized settings out of a link', () => {
    const p = song();
    p.tracks[1].plugins.push({ url: 'https://example.org/fx/index.js', name: 'Big', state: JSON.stringify({ blob: 'x'.repeat(5000) }) });
    const back = decodeBeat(encodeBeat(p))!;
    expect(back.tracks[1].plugins.map((x) => x.url)).toEqual(['plugins/pluck/index.js', 'https://example.org/fx/index.js']);
    expect(back.tracks[1].plugins[1].state).toBe('');
    expect(back.tracks[1].plugins[0].state).toBe(p.tracks[1].plugins[0].state);
  });

  it('leave links without plugins exactly as they were', () => {
    const p = song();
    p.tracks[1].kind = 'synth';
    const q = song();
    q.tracks[1].kind = 'synth';
    q.tracks[1].plugins = [];
    expect(encodeBeat(p)).toBe(encodeBeat(q));
  });

  it('only take plugins from a web address or the app\'s own folder', () => {
    expect(pluginUrlOk('https://a.b/c/index.js')).toBe(true);
    expect(pluginUrlOk('plugins/pluck/index.js')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/javascript,1', 'plugins/../../evil.js', '//evil.example/x.js', 'file:///etc/passwd', 'https://a.b/"onload=x', '', 42, null])
      expect(pluginUrlOk(bad)).toBe(false);
    const p = song();
    (p.tracks[1].plugins as unknown[]) = [{ url: 'javascript:alert(1)', name: 'x', state: '' }, { url: 'https://ok.example/p.js', name: 'y'.repeat(99), state: 7 }];
    const s = sanitize(p);
    expect(s.tracks[1].plugins).toEqual([{ url: 'https://ok.example/p.js', name: 'y'.repeat(40), state: '' }]);
  });
});

describe('the engine and plugins', () => {
  it('sends a plugin track\'s notes out on their exact frames, with their ends', async () => {
    const p = song();
    const seen: { track: number; on: boolean; pitch: number; vel: number; frame: number }[] = [];
    await renderProject(p, {}, { sampleRate: SR, chain: [0], onPlug: (track, on, pitch, vel, frame) => seen.push({ track, on, pitch, vel, frame }) });
    const step = (SR * 15) / p.bpm; // 6000 frames
    const ons = seen.filter((e) => e.on);
    expect(ons.map((e) => [e.pitch, e.vel, e.frame])).toEqual([[60, 100, 0], [64, 90, 4 * step], [67, 80, 8 * step]]);
    const offs = seen.filter((e) => !e.on && e.pitch >= 0);
    expect(offs.map((e) => e.pitch)).toEqual([60, 64, 67]);
    // a note ends when its length is up (give or take the gap the engine leaves so notes don't run together)
    expect(offs[0].frame).toBeGreaterThan(step);
    expect(offs[0].frame).toBeLessThanOrEqual(2 * step);
    expect(offs[2].frame).toBeLessThanOrEqual(12 * step);
    expect(seen.every((e) => e.track === 1)).toBe(true);
  });

  it('makes no sound of its own for a plugin track', async () => {
    const p = song();
    p.tracks[0].mute = true;
    const out = await renderProject(p, {}, { sampleRate: SR, chain: [0] });
    expect(out.l.some((x) => x !== 0)).toBe(false);
  });

  it('puts what the plugin played through the track: volume, pan, mute', async () => {
    const p = song();
    p.tracks[0].mute = true;
    const n = SR * 2;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const ext = { 1: { l: tone, r: tone } };
    const rms = (x: Float32Array) => Math.sqrt(x.subarray(0, SR).reduce((s, v) => s + v * v, 0) / SR);
    const flat = await renderProject(p, {}, { sampleRate: SR, chain: [0], ext });
    expect(rms(flat.l)).toBeGreaterThan(0.1);
    p.tracks[1].vol = 50;
    const quiet = await renderProject(p, {}, { sampleRate: SR, chain: [0], ext });
    expect(rms(quiet.l)).toBeLessThan(rms(flat.l) * 0.6);
    p.tracks[1].vol = 100;
    p.tracks[1].pan = -64;
    const left = await renderProject(p, {}, { sampleRate: SR, chain: [0], ext });
    expect(rms(left.r)).toBeLessThan(rms(left.l) * 0.05);
    p.tracks[1].mute = true;
    const off = await renderProject(p, {}, { sampleRate: SR, chain: [0], ext });
    expect(rms(off.l)).toBe(0);
    // and it is ignored on a track that isn't a plugin track
    p.tracks[1].mute = false;
    p.tracks[1].kind = 'synth';
    p.patterns[0].notes[1] = [];
    const synth = await renderProject(p, {}, { sampleRate: SR, chain: [0], ext });
    expect(rms(synth.l)).toBe(0);
  });

  it('ends held notes when the transport stops, and plays keys right away', () => {
    const p = song();
    const e = new Engine(SR);
    const seen: string[] = [];
    e.onPlug = (t, on, pitch) => seen.push(`${t}:${on ? 'on' : 'off'}:${pitch}`);
    e.setProject(p);
    e.noteOn(1, 72, 100);
    e.noteOff(1, 72);
    expect(seen).toEqual(['1:on:72', '1:off:72']);
    e.play({ pattern: 0 });
    const l = new Float32Array(1024), r = new Float32Array(1024);
    e.process(l, r, 1024);
    e.stop();
    expect(seen[seen.length - 1]).toBe('1:off:-1');
  });
});
