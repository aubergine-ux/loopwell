// .loopwell project files: a zip holding project.json plus the original bytes
// of any samples the user dropped in. This is how beats with custom samples
// travel, since those can't fit in a share link.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sanitize, usesSample, type Project } from './types';

export interface UserSample {
  id: string;
  name: string;
  bytes: Uint8Array;
}

interface Manifest {
  format: 'loopwell';
  version: 1 | 2;
  project: Project;
  samples: { id: string; name: string; file: string }[];
}

export function packProjectFile(project: Project, samples: UserSample[]): Uint8Array<ArrayBuffer> {
  const used = new Set(project.tracks.filter((t) => usesSample(t.kind)).map((t) => t.sample));
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { format: 'loopwell', version: 2, project, samples: [] };
  samples.filter((s) => used.has(s.id)).forEach((s, i) => {
    const file = `samples/${i}.bin`;
    files[file] = s.bytes;
    manifest.samples.push({ id: s.id, name: s.name, file });
  });
  files['project.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>;
}

export function unpackProjectFile(bytes: Uint8Array): { project: Project; samples: UserSample[] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('This is not a Loopwell project file.');
  }
  const json = files['project.json'];
  if (!json) throw new Error('This is not a Loopwell project file.');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(json));
  } catch {
    throw new Error('The project file is damaged.');
  }
  if (manifest?.format !== 'loopwell') throw new Error('This is not a Loopwell project file.');
  const samples: UserSample[] = [];
  for (const s of Array.isArray(manifest.samples) ? manifest.samples : []) {
    const data = files[s?.file];
    if (data && typeof s.id === 'string' && s.id.startsWith('user/')) samples.push({ id: s.id, name: String(s.name ?? 'sample'), bytes: data });
  }
  return { project: sanitize(manifest.project), samples };
}
