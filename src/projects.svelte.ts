// The beat library: every beat made in this browser, autosaved as it is worked
// on, with versions that can be gone back to. All of it stays on this device.

import { checkpoint, loadHooks, loadProject, newBeat, saveHooks, toast } from './actions.svelte';
import { newId, sanitize, type Project } from './core/types';
import {
  deleteProject as dropProject, deleteVersion as dropVersion, getProject, getVersion, listProjects, listVersions, loadText, putProject, putVersion,
  saveText, type ProjectRow, type VersionRow,
} from './storage';
import { app } from './state.svelte';

const CURRENT = 'loopwell:current';
const SAVE_DELAY = 1200;
const AUTO_EVERY = 10 * 60 * 1000;
const MAX_AUTO = 10;
const MAX_VERSIONS = 60;

export type ProjectInfo = Omit<ProjectRow, 'json'>;
export type VersionInfo = Omit<VersionRow, 'json'>;

export const library = $state({
  /** Id of the beat being worked on. */
  current: '',
  list: [] as ProjectInfo[],
  /** Versions of the current beat, newest first. */
  versions: [] as VersionInfo[],
  /** False when this browser won't store a library (private windows, mostly). The beat itself still autosaves. */
  available: true,
  ready: false,
});

const freshId = () => `${Date.now().toString(36)}${newId()}`;
const info = ({ json: _json, ...rest }: ProjectRow): ProjectInfo => rest;

let pending: string | null = null;
let timer = 0;
let created = Date.now();
let lastAuto = Date.now();

function row(json: string): ProjectRow {
  const p = app.project;
  return { id: library.current, name: p.name || 'untitled', created, updated: Date.now(), bpm: p.bpm, tracks: p.tracks.length, json };
}

/** Take what is waiting to be saved, as a finished row. Done in one go, so it can't be mixed up with a beat loaded a moment later. */
function take(): ProjectRow | null {
  checkpoint(); // an edit made a moment ago may not have been committed yet
  clearTimeout(timer);
  if (pending === null || !library.current || !library.available) return null;
  const r = row(pending);
  pending = null;
  return r;
}

async function write(r: ProjectRow | null): Promise<void> {
  if (!r) return;
  try {
    await putProject(r);
    const i = library.list.findIndex((x) => x.id === r.id);
    if (i >= 0) library.list[i] = info(r); else library.list.push(info(r));
    if (r.id === library.current && Date.now() - lastAuto > AUTO_EVERY) await snapshot('Autosave', true, r.json);
  } catch {
    library.available = false;
  }
}

/** Write the beat being worked on into the library now, if there is anything waiting. */
export function flush(): Promise<void> {
  return write(take());
}

/** A different beat is about to take over: save this one, and give the next its own place in the library. */
function startNew(): Promise<void> {
  const saving = write(take());
  library.current = freshId();
  created = Date.now();
  lastAuto = Date.now();
  library.versions = [];
  saveText(CURRENT, library.current);
  return saving;
}

let fresh = false;
/** Load a beat as a new entry in the library, leaving the one that was open as it is. */
export async function openAsNew(p: Project, label?: string): Promise<void> {
  await startNew();
  fresh = true;
  loadProject(p, label);
  fresh = false;
}

export async function initLibrary(): Promise<void> {
  // every committed change is saved a moment later, so a burst of edits is one write
  saveHooks.push((json) => {
    pending = json;
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), SAVE_DELAY);
  });
  addEventListener('pagehide', () => void flush());
  try {
    const rows = await listProjects();
    library.list = rows.map(info);
    const saved = loadText(CURRENT);
    const mine = rows.find((r) => r.id === saved);
    if (mine) {
      library.current = mine.id;
      created = mine.created;
      library.versions = await versionsOf(mine.id);
    } else {
      // the first time the library is used: the beat that was already autosaved becomes its first entry
      library.current = freshId();
      saveText(CURRENT, library.current);
      pending = JSON.stringify(app.project);
      await flush();
    }
  } catch {
    library.available = false;
  }
  library.ready = true;
}

async function versionsOf(id: string): Promise<VersionInfo[]> {
  const all = await listVersions(id);
  return all.map(({ json: _json, ...rest }) => rest).sort((a, b) => b.time - a.time);
}

export async function openProject(id: string): Promise<boolean> {
  if (id === library.current) return true;
  await flush();
  const r = await getProject(id).catch(() => undefined);
  if (!r) { toast('That beat is no longer in the library.', 'error'); return false; }
  let p: Project;
  try { p = sanitize(JSON.parse(r.json)); } catch { toast('That beat could not be read.', 'error'); return false; }
  await flush(); // anything edited while the other beat was being fetched
  library.current = id;
  created = r.created;
  lastAuto = Date.now();
  saveText(CURRENT, id);
  library.versions = await versionsOf(id).catch(() => []);
  fresh = true;
  loadProject(p);
  fresh = false;
  return true;
}

export async function createProject(): Promise<void> {
  await startNew();
  fresh = true;
  newBeat();
  fresh = false;
}

export async function duplicateProject(id: string): Promise<void> {
  await flush();
  const r = await getProject(id).catch(() => undefined);
  if (!r) return;
  const copy: ProjectRow = { ...r, id: freshId(), name: `${r.name} copy`.slice(0, 40), created: Date.now(), updated: Date.now() };
  try {
    const p = JSON.parse(r.json);
    p.name = copy.name;
    copy.json = JSON.stringify(p);
  } catch { /* an unreadable beat is copied as it is */ }
  await putProject(copy);
  library.list.push(info(copy));
}

export async function renameProject(id: string, name: string): Promise<void> {
  const n = name.trim().slice(0, 40) || 'untitled';
  if (id === library.current) { app.project.name = n; return; } // the autosave carries it into the library
  const r = await getProject(id).catch(() => undefined);
  if (!r) return;
  try {
    const p = JSON.parse(r.json);
    p.name = n;
    r.json = JSON.stringify(p);
  } catch { /* keep the beat, rename the entry */ }
  r.name = n;
  await putProject(r);
  const i = library.list.findIndex((x) => x.id === id);
  if (i >= 0) library.list[i] = info(r);
}

export async function removeProject(id: string): Promise<void> {
  await dropProject(id).catch(() => {});
  library.list = library.list.filter((x) => x.id !== id);
  if (id !== library.current) return;
  // the open beat was the one removed: move to the most recent other one, or start afresh
  pending = null;
  const next = [...library.list].sort((a, b) => b.updated - a.updated)[0];
  library.current = '';
  if (next) await openProject(next.id);
  else await createProject();
}

// --- versions --------------------------------------------------------------

async function snapshot(label: string, auto: boolean, json: string): Promise<void> {
  const v: VersionRow = { id: freshId(), project: library.current, time: Date.now(), label: label.trim().slice(0, 40) || 'Version', auto, json };
  await putVersion(v);
  lastAuto = Date.now();
  const { json: _json, ...meta } = v;
  library.versions = [meta, ...library.versions];
  // old automatic versions make way for new ones; ones that were asked for stay until there are a great many
  const autos = library.versions.filter((x) => x.auto);
  const extra = [...autos.slice(MAX_AUTO), ...library.versions.filter((x) => !x.auto).slice(MAX_VERSIONS)];
  for (const x of extra) await dropVersion(x.id).catch(() => {});
  if (extra.length) library.versions = library.versions.filter((x) => !extra.includes(x));
}

/** Keep the beat as it is right now, to come back to. */
export async function saveVersion(label = ''): Promise<boolean> {
  if (!library.available) { toast('This browser is not keeping a library, so versions can\'t be saved. Export a project file instead.', 'error'); return false; }
  try {
    await snapshot(label || `Version ${library.versions.filter((x) => !x.auto).length + 1}`, false, JSON.stringify(app.project));
    toast('Version saved');
    return true;
  } catch {
    toast('The version could not be saved.', 'error');
    return false;
  }
}

/** Go back to a saved version. The beat as it was stays in undo. */
export async function restoreVersion(id: string): Promise<void> {
  const v = await getVersion(id).catch(() => undefined);
  if (!v) { toast('That version is no longer there.', 'error'); return; }
  try {
    fresh = true;
    loadProject(sanitize(JSON.parse(v.json)), `Went back to “${v.label}”`);
  } catch {
    toast('That version could not be read.', 'error');
  } finally {
    fresh = false;
  }
}

export async function removeVersion(id: string): Promise<void> {
  await dropVersion(id).catch(() => {});
  library.versions = library.versions.filter((x) => x.id !== id);
}

// Anything else that loads a beat (a link, a file, a demo) arrives as a new entry, so it never overwrites the one that was open.
loadHooks.push(() => { if (!fresh && library.ready) void startNew(); });
