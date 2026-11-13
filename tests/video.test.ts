import { describe, expect, it } from 'vitest';
import { hitTimeline } from '../src/core/hits';
import { TEMPLATES } from '../src/core/templates';
import { sanitize } from '../src/core/types';
import { envelopes, VIDEO_SIZES } from '../src/video/draw';

describe('hit timeline', () => {
  const p = sanitize(TEMPLATES[0].make());

  it('gives every lit step of a pattern its time', () => {
    const hits = hitTimeline(p, [0]);
    const step = 15 / p.bpm;
    let lit = 0;
    p.tracks.forEach((t, i) => {
      if (t.mute) return;
      if (t.kind === 'drum' || t.kind === 'slice' || t.kind === 'dsyn') lit += p.patterns[0].steps[i].filter((v) => v > 0).length;
    });
    expect(hits.length).toBeGreaterThanOrEqual(lit);
    expect(lit).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.t).toBeGreaterThanOrEqual(0);
      expect(h.t).toBeLessThan(p.steps * step);
      expect(Math.abs(h.t / step - Math.round(h.t / step))).toBeLessThan(1e-9);
    }
    for (let i = 1; i < hits.length; i++) expect(hits[i].t).toBeGreaterThanOrEqual(hits[i - 1].t);
  });

  it('plays a chain one pattern after another', () => {
    const once = hitTimeline(p, [0]), twice = hitTimeline(p, [0, 0]);
    expect(twice.length).toBe(once.length * 2);
    expect(twice[once.length].t).toBeCloseTo(once[0].t + (p.steps * 15) / p.bpm, 9);
  });

  it('leaves muted tracks out', () => {
    const q = structuredClone(p);
    q.tracks[0].mute = true;
    expect(hitTimeline(q, [0]).some((h) => h.track === 0)).toBe(false);
  });
});

describe('video frames', () => {
  it('follows the level of the sound', () => {
    const sr = 48000, l = new Float32Array(sr);
    for (let i = sr / 2; i < sr; i++) l[i] = Math.sin((2 * Math.PI * 60 * i) / sr) * 0.8;
    const { level, bass } = envelopes(l, l, sr);
    expect(level.length).toBeGreaterThan(20);
    expect(level[2]).toBeLessThan(0.01);
    expect(level[level.length - 3]).toBeGreaterThan(0.2);
    expect(bass[bass.length - 3]).toBeGreaterThan(0.2);
  });

  it('has even sizes, as video encoders need', () => {
    for (const s of Object.values(VIDEO_SIZES)) expect(s.w % 2 + s.h % 2).toBe(0);
  });
});
