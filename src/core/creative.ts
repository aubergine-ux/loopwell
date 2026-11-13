// The pattern tools that go beyond "a hit on a step": Euclidean rhythms,
// groove templates, per-step chance / conditions / ratchets, and the
// arpeggiator's tables. Pure functions and constants; the engine does the playing.

// --- Euclidean rhythms -----------------------------------------------------

/** `pulses` hits spread as evenly as possible over `steps`, turned right by `rotation`. */
export function euclid(steps: number, pulses: number, rotation = 0): boolean[] {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.max(0, Math.min(n, Math.floor(pulses)));
  const out = new Array<boolean>(n).fill(false);
  // the same pattern Bjorklund's algorithm gives, starting on a hit
  for (let i = 0; i < n; i++) out[(((i + rotation) % n) + n) % n] = (i * k) % n < k;
  return out;
}

// --- step extras -----------------------------------------------------------
// One small integer per step: bits 0-1 ratchet (0 = one hit .. 3 = four),
// bits 2-4 chance (index into CHANCES), bits 5-8 condition (index into CONDITIONS).
// 0 means a plain step, so untouched patterns cost nothing anywhere.

export const CHANCES = [100, 90, 75, 66, 50, 33, 25, 10];
export const CONDITIONS = ['Always', '1st of 2', '2nd of 2', '1st of 3', '2nd of 3', '3rd of 3', '1st of 4', '2nd of 4', '3rd of 4', '4th of 4', 'Fill only', 'Not in fill', 'First loop', 'After first'];
export const MAX_RATCHET = 4;
export const MAX_MOD = 511;

export const modRatchet = (m: number) => (m & 3) + 1;
export const modChance = (m: number) => (m >> 2) & 7;
export const modCond = (m: number) => (m >> 5) & 15;
export const makeMod = (ratchet: number, chance: number, cond: number) =>
  ((ratchet - 1) & 3) | ((chance & 7) << 2) | ((cond < CONDITIONS.length ? cond : 0) << 5);

/** Does a step with this condition play on loop number `loop` (0 = the first time through)? */
export function condPass(cond: number, loop: number, fill: boolean): boolean {
  switch (cond) {
    case 0: return true;
    case 1: case 2: return loop % 2 === cond - 1;
    case 3: case 4: case 5: return loop % 3 === cond - 3;
    case 6: case 7: case 8: case 9: return loop % 4 === cond - 6;
    case 10: return fill;
    case 11: return !fill;
    case 12: return loop === 0;
    case 13: return loop > 0;
    default: return true;
  }
}

/** A few words for a step's extras, for labels and tooltips. Empty for a plain step. */
export function modLabel(m: number): string {
  const out: string[] = [];
  if (modChance(m)) out.push(`${CHANCES[modChance(m)]}%`);
  if (modCond(m)) out.push(CONDITIONS[modCond(m)].toLowerCase());
  if (modRatchet(m) > 1) out.push(`×${modRatchet(m)}`);
  return out.join(', ');
}

// --- grooves ---------------------------------------------------------------
// A groove pushes hits late and shapes their velocity, by where they fall in
// the bar. Hits are only ever delayed, so nothing needs to be known ahead of time.

export interface Groove {
  name: string;
  blurb: string;
  /** How late the hit on 16th `pos` of the bar plays, in steps. `amt` and both random numbers are 0..1. */
  delay: (pos: number, amt: number, rnd: number) => number;
  /** What its velocity is multiplied by. */
  vel: (pos: number, amt: number, rnd: number) => number;
}

const one = () => 1;
export const GROOVES: Groove[] = [
  { name: 'Straight', blurb: 'Right on the grid', delay: () => 0, vel: one },
  { name: 'MPC swing', blurb: 'Off-beat 16ths lean late', delay: (pos, amt) => (pos & 1 ? amt * 0.5 : 0), vel: (pos, amt) => (pos & 1 ? 1 - amt * 0.15 : 1) },
  { name: 'Shuffle', blurb: 'The off-beat 8th falls back towards a triplet', delay: (pos, amt) => (pos % 4 === 2 ? amt * 0.667 : pos % 4 === 3 ? amt * 0.333 : 0), vel: one },
  { name: 'Laid back', blurb: 'Backbeats drag, off-beats soften', delay: (pos, amt) => (pos % 8 === 4 ? amt * 0.35 : pos & 1 ? amt * 0.12 : 0), vel: (pos, amt) => (pos & 1 ? 1 - amt * 0.3 : 1) },
  { name: 'Humanize', blurb: 'Small random changes in timing and velocity', delay: (_p, amt, rnd) => rnd * amt * 0.3, vel: (_p, amt, rnd) => 1 - rnd * amt * 0.4 },
  { name: 'Loose', blurb: 'Swung and sloppy, like tired hands', delay: (pos, amt, rnd) => (pos & 1 ? amt * 0.3 : 0) + rnd * amt * 0.4, vel: (_p, amt, rnd) => 1 - rnd * amt * 0.5 },
];

// --- arpeggiator -----------------------------------------------------------

export const ARP_MODES = ['Off', 'Up', 'Down', 'Up-down', 'Random'];
/** Arpeggiator note lengths in 16th-note steps. */
export const ARP_RATES = [4, 2, 1, 0.5];
export const ARP_RATE_LABELS = ['1/4', '1/8', '1/16', '1/32'];
export const MAX_ARP_OCT = 3;

/** Which of `total` notes the arpeggiator is on at its `i`th tick. `rnd` is 0..1. */
export function arpIndex(mode: number, i: number, total: number, rnd: number): number {
  if (total <= 1) return 0;
  if (mode === 2) return total - 1 - (i % total);
  if (mode === 3) {
    const k = i % (2 * total - 2);
    return k < total ? k : 2 * total - 2 - k;
  }
  if (mode === 4) return Math.min(total - 1, Math.floor(rnd * total));
  return i % total;
}
