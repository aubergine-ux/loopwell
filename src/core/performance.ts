// Turning a live performance into a song: the clip launches that were played
// become clips on the timeline, and a filter sweep becomes automation.

import { MAX_SONG_STEPS, newId, type AutoLane, type AutoPoint, type Clip } from './types';

/** What every track was looping from step `at` (counted from when play was pressed) onwards; -2 = silent. */
export interface LaunchEvent {
  at: number;
  tracks: number[];
}

/**
 * Clips for a recorded take. `from` and `to` are the steps the recording ran between. The song starts on the bar
 * line at or before `from`, with whatever was looping when record was pressed filling that first bar from its top,
 * so what was played stays in the bar it was played in and the song doesn't open on a gap.
 */
export function launchesToClips(log: LaunchEvent[], from: number, to: number, steps: number, tracks: number): Clip[] {
  const origin = from - (from % steps);
  const end = Math.min(MAX_SONG_STEPS, Math.ceil((to - origin) / steps) * steps);
  const clips: Clip[] = [];
  const events = [...log].sort((a, b) => a.at - b.at).map((e, i) => (i === 0 ? { ...e, at: Math.min(e.at, origin) } : e));
  for (let t = 0; t < tracks; t++) {
    let open: Clip | null = null;
    const close = (at: number) => {
      if (open && at > open.start) { open.len = at - open.start; clips.push(open); }
      open = null;
    };
    for (const e of events) {
      const at = Math.max(0, Math.min(end, e.at - origin));
      const pattern = e.tracks[t] ?? -2;
      if (open && open.pattern === pattern) continue;
      close(at);
      // a launched pattern keeps time with the loop it joined, so it starts part-way through if it came in mid-bar
      if (pattern >= 0 && at < end) open = { id: newId(), track: t, pattern, start: at, len: 0, offset: e.at % steps };
    }
    close(end);
  }
  return clips;
}

/** A lane from values sampled once a step, leaving out points that add nothing to the line. */
export function samplesToLane(samples: AutoPoint[], track: number, param: string, origin: number, rest: number): AutoLane | null {
  const pts = samples
    .map((s) => ({ t: Math.max(0, s.t - origin), v: s.v }))
    .filter((s) => s.t <= MAX_SONG_STEPS)
    .sort((a, b) => a.t - b.t);
  const points: AutoPoint[] = [];
  for (const pt of pts) {
    const last = points[points.length - 1];
    if (last && last.t === pt.t) { last.v = pt.v; continue; }
    const prev = points[points.length - 2];
    if (last && prev && prev.v === last.v && last.v === pt.v) { last.t = pt.t; continue; } // a flat run needs only its two ends
    points.push({ ...pt });
  }
  if (!points.some((pt) => pt.v !== rest)) return null; // it was never moved
  return { id: newId(), track, param, on: true, points: points.slice(0, 512) };
}
