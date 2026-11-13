// The sample library: every built-in sound and everything imported, with
// favourites and tags (kept in this browser) and what analysis says about each.

import { audio } from './audio/host';
import { detectBpm, detectKey } from './core/analyze';
import { ALL_SAMPLES, KITS, isBuiltin, slotLabel, type Slot } from './core/kits';
import { app } from './state.svelte';

const KEY = 'loopwell:library';
const MAX_TAG = 20;

export interface Info {
  seconds: number;
  bpm: number | null;
  key: string | null;
}

export interface Entry {
  id: string;
  name: string;
  builtin: boolean;
  /** Where it comes from: a kit's name, or "Imported". */
  source: string;
  /** Tags it always has, from what it is. */
  auto: string[];
}

const CATEGORY: Record<Slot, string> = {
  kick: 'kick', snare: 'snare', clap: 'clap', hat: 'hat', open: 'hat', tom: 'tom', rim: 'perc', perc: 'perc', crash: 'cymbal', sub: 'bass',
};
export const CATEGORIES = ['kick', 'snare', 'clap', 'hat', 'tom', 'perc', 'cymbal', 'bass'];

function load(): { fav: string[]; tags: Record<string, string[]> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const tags: Record<string, string[]> = {};
    if (raw.tags && typeof raw.tags === 'object') {
      for (const id of Object.keys(raw.tags)) if (Array.isArray(raw.tags[id])) tags[id] = raw.tags[id].filter((x: unknown) => typeof x === 'string').slice(0, 12);
    }
    return { fav: Array.isArray(raw.fav) ? raw.fav.filter((x: unknown) => typeof x === 'string') : [], tags };
  } catch {
    return { fav: [], tags: {} };
  }
}

const saved = load();
export const library = $state({
  fav: saved.fav,
  tags: saved.tags,
  /** What analysis found, by sample id. Filled in as samples are looked at. */
  info: {} as Record<string, Info>,
});

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify({ fav: library.fav, tags: library.tags })); } catch { /* private mode or full */ }
}

const BUILTIN: Entry[] = ALL_SAMPLES.map((id) => {
  const [kit, slot] = id.split('/') as [string, Slot];
  const k = KITS.find((x) => x.id === kit)!;
  const name = slotLabel(id);
  return { id, name, builtin: true, source: k.name, auto: [...new Set([CATEGORY[slot], slot, name, k.name.toLowerCase(), 'one-shot'])] };
});

/** Everything in the library: imported sounds first (newest names first by nature of being yours), then the kits. */
export function entries(): Entry[] {
  const mine: Entry[] = Object.entries(app.userSamples)
    .map(([id, name]) => ({ id, name: name.replace(/\.[a-z0-9]{2,5}$/i, ''), builtin: false, source: 'Imported', auto: ['imported'] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...mine, ...BUILTIN];
}

export const isFav = (id: string) => library.fav.includes(id);
export function toggleFav(id: string): void {
  library.fav = isFav(id) ? library.fav.filter((x) => x !== id) : [...library.fav, id];
  save();
}

export function addTag(id: string, tag: string): boolean {
  const t = tag.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_TAG);
  const have = library.tags[id] ?? [];
  if (!t || have.includes(t) || have.length >= 12) return false;
  library.tags[id] = [...have, t];
  save();
  return true;
}

export function removeTag(id: string, tag: string): void {
  const left = (library.tags[id] ?? []).filter((x) => x !== tag);
  if (left.length) library.tags[id] = left; else delete library.tags[id];
  save();
}

/** Forget what was kept about a sample that has been removed. */
export function forgetEntry(id: string): void {
  library.fav = library.fav.filter((x) => x !== id);
  delete library.tags[id];
  delete library.info[id];
  save();
}

/** Tags worked out from the audio: its tempo and key, and whether it is a loop. */
export function foundTags(id: string): string[] {
  const i = library.info[id];
  if (!i) return [];
  const out: string[] = [];
  if (i.bpm) out.push('loop', `${Math.round(i.bpm)} bpm`);
  if (i.key) out.push(i.key.toLowerCase());
  return out;
}

/**
 * Does an entry match what was typed? Either the whole phrase starts one of its tags ("a minor", "120 bpm"),
 * or every word typed starts a word of its name, source or tags ("dust hat").
 */
export function matches(e: Entry, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return true;
  const fields = [e.name, e.source, ...e.auto, ...(library.tags[e.id] ?? []), ...foundTags(e.id)].map((f) => f.toLowerCase());
  if (fields.some((f) => f.startsWith(q))) return true;
  const have = fields.flatMap((f) => f.split(/[\s\-_.]+/));
  const words = q.split(' ');
  // one letter is a note name when it is part of a phrase; on its own it would match half the library
  return words.length > 1 && words.some((w) => w.length < 2) ? false : words.every((w) => have.some((h) => h.startsWith(w)));
}

/** Work out a sample's length, tempo and key, once. Loads it first if it is a built-in that hasn't been fetched. */
export async function analyze(id: string): Promise<Info | null> {
  if (library.info[id]) return library.info[id];
  if (!audio.bank[id] && !(isBuiltin(id) && (await audio.ensure(id)))) return null;
  const d = audio.bank[id];
  if (!d) return null;
  const sr = audio.sampleRate;
  const info: Info = { seconds: d.l.length / sr, bpm: detectBpm(d.l, sr, d.r), key: detectKey(d.l, sr, d.r)?.name ?? null };
  library.info[id] = info;
  return info;
}

let sweeping = false;
/** Analyse everything that is already loaded, a sample at a time, so tempo and key can be searched for. */
export async function analyzeLoaded(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const e of entries()) {
      if (library.info[e.id] || !audio.bank[e.id]) continue;
      await analyze(e.id);
      await new Promise((r) => setTimeout(r)); // let the page breathe between files
    }
  } finally {
    sweeping = false;
  }
}
