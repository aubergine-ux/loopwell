// Local persistence. The beat being worked on autosaves to localStorage, so it
// is there the instant the app opens. Everything bigger or more numerous lives
// in IndexedDB: dropped-in samples, the library of beats, and their saved versions.

import type { UserSample } from './core/projectfile';

const PROJECT_KEY = 'loopwell:project';
const THEME_KEY = 'loopwell:theme';

export function loadSaved(): unknown {
  try {
    const s = localStorage.getItem(PROJECT_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function saveProject(json: string): void {
  try { localStorage.setItem(PROJECT_KEY, json); } catch { /* private mode or full: nothing to do */ }
}

export function loadTheme(): string | null {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

export function saveTheme(id: string): void {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* ignore */ }
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // version 1 had only the samples; 2 added the beat library and its saved versions
    const req = indexedDB.open('loopwell', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('samples')) d.createObjectStore('samples', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: 'id' }).createIndex('project', 'project');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putSample(s: UserSample): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('samples', 'readwrite');
      tx.objectStore('samples').put(s);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    d.close();
  } catch { /* storage unavailable: the sample still works until reload */ }
}

export async function deleteSample(id: string): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('samples', 'readwrite');
      tx.objectStore('samples').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    d.close();
  } catch { /* nothing stored, nothing to remove */ }
}

export async function getSamples(): Promise<UserSample[]> {
  try {
    const d = await db();
    const all = await new Promise<UserSample[]>((resolve, reject) => {
      const req = d.transaction('samples').objectStore('samples').getAll();
      req.onsuccess = () => resolve(req.result as UserSample[]);
      req.onerror = () => reject(req.error);
    });
    d.close();
    return all;
  } catch {
    return [];
  }
}

// --- the beat library ------------------------------------------------------

/** A beat in the library. `json` is the whole project; the rest is what a list needs without parsing it. */
export interface ProjectRow {
  id: string;
  name: string;
  created: number;
  updated: number;
  bpm: number;
  tracks: number;
  json: string;
}

/** A saved point in a beat's life that can be gone back to. */
export interface VersionRow {
  id: string;
  project: string;
  time: number;
  label: string;
  /** Made by the app on its own (and thinned out over time), rather than asked for. */
  auto: boolean;
  json: string;
}

async function run<T>(store: string, mode: IDBTransactionMode, job: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = job(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

export const listProjects = () => run<ProjectRow[]>('projects', 'readonly', (s) => s.getAll()).then((x) => x ?? []);
export const getProject = (id: string) => run<ProjectRow>('projects', 'readonly', (s) => s.get(id));
export const putProject = (row: ProjectRow) => run('projects', 'readwrite', (s) => { s.put(row); });
export const listVersions = (project: string) => run<VersionRow[]>('versions', 'readonly', (s) => s.index('project').getAll(project)).then((x) => x ?? []);
export const getVersion = (id: string) => run<VersionRow>('versions', 'readonly', (s) => s.get(id));
export const putVersion = (row: VersionRow) => run('versions', 'readwrite', (s) => { s.put(row); });
export const deleteVersion = (id: string) => run('versions', 'readwrite', (s) => { s.delete(id); });

/** Remove a beat and every version saved of it. */
export async function deleteProject(id: string): Promise<void> {
  const versions = await listVersions(id);
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(['projects', 'versions'], 'readwrite');
      tx.objectStore('projects').delete(id);
      for (const v of versions) tx.objectStore('versions').delete(v.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

// --- preferences -----------------------------------------------------------

const PREFS_KEY = 'loopwell:prefs';

export function loadPrefs(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs: object): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode or full */ }
}

export function loadText(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function saveText(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode or full */ }
}
