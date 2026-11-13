import { describe, expect, it } from 'vitest';
import { envelopes, VIDEO_SIZES } from '../src/video/draw';

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
