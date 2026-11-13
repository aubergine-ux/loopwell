// Vocal chains: a rack of effects and send levels that turn a raw take into a
// finished vocal in one step. Each is an ordinary rack, so every knob in it can
// be changed afterwards.

import type { InsertFx } from './types';

export interface VocalChain {
  id: string;
  name: string;
  blurb: string;
  fx: InsertFx[];
  /** Reverb and delay sends for the track. */
  rev: number;
  dly: number;
}

const fx = (type: InsertFx['type'], ...p: number[]): InsertFx => ({ type, on: true, p });

export const VOCAL_CHAINS: VocalChain[] = [
  {
    id: 'clean', name: 'Clean', blurb: 'Even, clear and close: the lows tidied, the hiss tamed, a little room',
    fx: [fx('eq', 48, 60, 76, 60), fx('comp', 62, 28, 30, 40), fx('deess', 64, 72, 80, 0)],
    rev: 34, dly: 0,
  },
  {
    id: 'trap', name: 'Trap', blurb: 'Hard-tuned and bright, squeezed flat, with echoes and a wide double',
    fx: [fx('tune', 127, 127, 0, 64), fx('eq', 40, 58, 88, 70), fx('comp', 74, 60, 8, 54), fx('deess', 70, 76, 100, 0), fx('harm', 64, 64, 90, 80)],
    rev: 44, dly: 58,
  },
  {
    id: 'lofi', name: 'Lo-fi', blurb: 'Dull, wobbly and a little broken, like an old tape',
    fx: [fx('eq', 44, 80, 26, 46), fx('crush', 62, 58, 80, 20), fx('chorus', 28, 52, 44, 90), fx('comp', 60, 40, 30, 36)],
    rev: 50, dly: 20,
  },
  {
    id: 'radio', name: 'Radio', blurb: 'Thin and gritty, as if through a telephone or a megaphone',
    fx: [fx('eq', 6, 104, 14, 72), fx('drive', 64, 70, 127, 0), fx('comp', 84, 70, 4, 60)],
    rev: 0, dly: 0,
  },
];
