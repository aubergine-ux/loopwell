// The mastering assistant: presets by genre, and working out how hard to push
// the limiter so a song comes out at the loudness asked for.

import { integratedLoudness, samplePeak } from './loudness';
import { renderProject, type SampleBank } from './render';
import type { Mastering, Project } from './types';

export interface MasterPreset {
  id: string;
  name: string;
  blurb: string;
  set: Pick<Mastering, 'low' | 'mid' | 'high' | 'glue' | 'width' | 'target'>;
}

// EQ knobs: 64 is flat and each 5.3 is one decibel
export const MASTER_PRESETS: MasterPreset[] = [
  { id: 'streaming', name: 'Streaming', blurb: 'Balanced and unhyped, at the level streaming services play', set: { low: 64, mid: 64, high: 67, glue: 36, width: 64, target: 14 } },
  { id: 'trap', name: 'Trap', blurb: 'Heavy lows, crisp top, loud', set: { low: 78, mid: 60, high: 74, glue: 70, width: 74, target: 9 } },
  { id: 'house', name: 'House', blurb: 'Solid kick, wide and bright, club loud', set: { low: 74, mid: 64, high: 74, glue: 60, width: 84, target: 9 } },
  { id: 'boombap', name: 'Boom bap', blurb: 'Warm and punchy, with the top left soft', set: { low: 74, mid: 68, high: 60, glue: 52, width: 62, target: 11 } },
  { id: 'lofi', name: 'Lo-fi', blurb: 'Soft, narrow and quiet, nothing sharp', set: { low: 68, mid: 64, high: 46, glue: 40, width: 54, target: 14 } },
  { id: 'drill', name: 'Drill', blurb: 'Sub-heavy and sharp, very loud', set: { low: 80, mid: 58, high: 78, glue: 76, width: 72, target: 8 } },
];

/** Loudness targets offered, as LUFS below zero. */
export const MASTER_TARGETS = [{ lufs: 14, label: '−14 streaming' }, { lufs: 11, label: '−11 punchy' }, { lufs: 9, label: '−9 loud' }, { lufs: 8, label: '−8 very loud' }];

export interface MasterReport {
  /** The gain knob value that reaches the target. */
  gain: number;
  /** Integrated loudness without the chain, and with it at that gain. */
  before: number;
  after: number;
  /** Highest sample of the mastered song, linear. */
  peak: number;
  /** The song could not be made as loud as asked, even with the limiter working as hard as it can. */
  short: boolean;
}

const gainFor = (db: number) => Math.max(0, Math.min(127, Math.round(64 + (db / 24) * 64)));

/**
 * Find the gain that brings the mastered song to its loudness target, by rendering it and measuring. The limiter
 * takes back some of whatever gain it is given, so it takes a few goes to land on the number.
 */
export async function findMasterGain(
  project: Project, bank: SampleBank, sampleRate: number, chain: number[] | undefined, onProgress?: (done: number) => void | Promise<void>,
): Promise<MasterReport> {
  const render = async (m: Mastering, part: number, of: number) => {
    const r = await renderProject({ ...project, mastering: m }, bank, { sampleRate, chain, maxTail: 2, onProgress: (d) => onProgress?.((part + d) / of) });
    return { lufs: integratedLoudness(r.l, r.r, sampleRate), peak: samplePeak(r.l, r.r) };
  };
  const target = -project.mastering.target;
  const passes = 5;
  const before = (await render({ ...project.mastering, on: false }, 0, passes + 1)).lufs;
  let db = 0, got = { lufs: before, peak: 0 };
  for (let i = 0; i < passes; i++) {
    // what is reported is always measured at the gain that is returned
    got = await render({ ...project.mastering, on: true, gain: gainFor(db) }, i + 1, passes + 1);
    if (got.lufs <= -69) break; // silence: there is nothing to bring up
    const miss = target - got.lufs;
    if (Math.abs(miss) < 0.25 || i === passes - 1) break;
    // pushing into a limiter gives less and less back, so overshoot a little when a lot is still missing
    const next = Math.max(-24, Math.min(24, db + miss * (i === 0 ? 1 : 1.25)));
    if (gainFor(next) === gainFor(db)) break; // as close as the knob's steps allow, or already at the end of its travel
    db = next;
  }
  return { gain: gainFor(db), before, after: got.lufs, peak: got.peak, short: target - got.lufs > 0.6 };
}
