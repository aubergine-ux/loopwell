// Local persistence. The beat itself autosaves to localStorage; dropped-in
// samples are bigger, so their original bytes live in IndexedDB.

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
    const req = indexedDB.open('loopwell', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('samples', { keyPath: 'id' });
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
