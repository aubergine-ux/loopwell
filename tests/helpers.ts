import type { Project } from '../src/core/types';

/** A project with the things that don't travel (clip and lane ids, clip order) evened out, for comparing. */
export function plain(p: Project): Project {
  const c = structuredClone(p);
  c.arr.clips = c.arr.clips.map((x) => ({ ...x, id: '' })).sort((a, b) => a.start - b.start || a.track - b.track);
  c.arr.lanes = c.arr.lanes.map((l) => ({ ...l, id: '' }));
  return c;
}
