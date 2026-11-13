import { describe, expect, it } from 'vitest';
import { CHALLENGES, PASS, blankOf, closeness, hint } from '../src/core/learn';
import { sanitize } from '../src/core/types';

describe('recreate this beat', () => {
  it('scores a perfect copy as 1 and an empty grid as 0', () => {
    for (const c of CHALLENGES) {
      const target = sanitize(c.make());
      expect(closeness(target, target).score).toBe(1);
      const blank = sanitize(blankOf(target, 'x'));
      const s = closeness(target, blank);
      expect(s.score).toBe(0);
      expect(s.missing).toBeGreaterThan(5);
      expect(s.right + s.extra).toBe(0);
      // the starting point has the same sounds and tempo
      expect(blank.bpm).toBe(target.bpm);
      expect(blank.tracks.map((t) => t.sample)).toEqual(target.tracks.map((t) => t.sample));
    }
  });

  it('gets closer with every right hit, and further with every wrong one', () => {
    const target = sanitize(CHALLENGES[0].make());
    const mine = sanitize(blankOf(target, 'x'));
    let last = 0;
    for (const s of [0, 4, 8, 12]) {
      mine.patterns[0].steps[0][s] = 100;
      const now = closeness(target, mine).score;
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    mine.patterns[0].steps[0][1] = 100;
    expect(closeness(target, mine).score).toBeLessThan(last);
    const kick = closeness(target, mine).tracks.find((t) => t.name === 'KICK')!;
    expect([kick.right, kick.missing, kick.extra]).toEqual([4, 0, 1]);
    expect(hint(kick)).toBe('1 too many');
  });

  it('can\'t be beaten by filling every step', () => {
    const target = sanitize(CHALLENGES[0].make());
    const mine = sanitize(blankOf(target, 'x'));
    for (let t = 0; t < 6; t++) for (let s = 0; s < 16; s++) mine.patterns[0].steps[t][s] = 100;
    expect(closeness(target, mine).score).toBeLessThan(0.4);
  });

  it('doesn\'t mind how hard a hit is or how long a note', () => {
    const target = sanitize(CHALLENGES[3].make());
    const mine: typeof target = JSON.parse(JSON.stringify(target));
    mine.patterns[0].steps[0][0] = 40;
    mine.patterns[0].notes[6][0].l = 1;
    mine.patterns[0].notes[6][0].v = 50;
    expect(closeness(target, mine).score).toBe(1);
  });

  it('tells a wrong note on the right step from a missing one', () => {
    const target = sanitize(CHALLENGES[3].make());
    const mine: typeof target = JSON.parse(JSON.stringify(target));
    mine.patterns[0].notes[6][2].p += 2;
    mine.patterns[0].notes[6].pop();
    const bass = closeness(target, mine).tracks.find((t) => t.name === 'BASS')!;
    expect([bass.right, bass.missing, bass.extra, bass.wrongNote]).toEqual([2, 2, 1, 1]);
    expect(hint(bass)).toBe('1 missing, 1 on the right step but the wrong note');
    expect(closeness(target, mine).score).toBeLessThan(1);
    expect(closeness(target, mine).score).toBeGreaterThan(PASS - 0.1);
  });

  it('ignores what is past the end of the pattern, and other patterns', () => {
    const target = sanitize(CHALLENGES[0].make());
    const mine: typeof target = JSON.parse(JSON.stringify(target));
    mine.patterns[0].steps[0][20] = 100;
    mine.patterns[1].steps[0][3] = 100;
    expect(closeness(target, mine).score).toBe(1);
  });

  it('has challenges that can be told apart and get harder', () => {
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(CHALLENGES.length);
    const levels = CHALLENGES.map((c) => c.level);
    expect([...levels].sort()).toEqual(levels);
    for (const a of CHALLENGES) for (const b of CHALLENGES) if (a !== b) expect(closeness(sanitize(a.make()), sanitize(b.make())).score).toBeLessThan(PASS);
  });
});
