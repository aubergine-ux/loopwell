// Computer-keyboard control. Uses physical key positions (event.code), so it
// works the same on any layout.

import {
  cycleTheme, noteDown, noteUp, padDown, padUp, redo, selectPattern, setView, tapTempo, togglePlay, undo, clearTrack,
} from './actions.svelte';
import { degreeToPitch } from './core/scales';
import { NUM_PATTERNS, clamp, isPitched } from './core/types';
import { setFill } from './creative.svelte';
import { deleteClip, duplicateClip } from './song.svelte';
import { app, TABS } from './state.svelte';

const HOME = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'];
const down = new Map<string, () => void>(); // code -> release

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function press(code: string): boolean {
  const p = app.project;
  const digit = /^Digit([1-8])$/.exec(code);
  if (digit) {
    const t = +digit[1] - 1;
    if (t >= p.tracks.length) return true;
    padDown(t);
    down.set(code, () => padUp(t));
    return true;
  }
  if (code === 'Backslash') {
    setFill(true);
    down.set(code, () => setFill(false));
    return true;
  }
  const i = HOME.indexOf(code);
  if (i < 0) return false;
  const t = app.sel;
  if (p.tracks[t]?.kind === 'slice') {
    // home row plays the slices in order
    if (i >= Math.max(1, p.tracks[t].slices.length)) return true;
    noteDown(t, i);
    down.set(code, () => noteUp(t, i));
  } else if (p.tracks[t] && isPitched(p.tracks[t].kind)) {
    // home row walks up the scale, so every key is a right note
    const base = p.tracks[t].note + 12 * app.octave;
    const pitch = p.scaleLock ? degreeToPitch(p.scaleRoot, p.scaleType, base, i) : base + i;
    noteDown(t, pitch);
    down.set(code, () => noteUp(t, pitch));
  } else if (i < p.tracks.length) {
    padDown(i);
    down.set(code, () => padUp(i));
  }
  return true;
}

export function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { app.modal = null; return; }
  if (typing(e) || app.modal) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (e.code === 'KeyY') { e.preventDefault(); redo(); }
    else if (e.code === 'KeyD' && app.clip && app.project.songMode) { e.preventDefault(); duplicateClip(app.clip); }
    return;
  }
  if (e.altKey) return;
  if (e.repeat) { if (down.has(e.code) || e.code === 'Space') e.preventDefault(); return; }
  if (press(e.code)) { e.preventDefault(); return; }
  const p = app.project;
  switch (e.code) {
    case 'Space': togglePlay(); break;
    case 'KeyR': app.rec = !app.rec; break;
    case 'KeyT': tapTempo(); break;
    case 'KeyM':
      if (e.shiftKey) p.tracks[app.sel].solo = !p.tracks[app.sel].solo;
      else p.tracks[app.sel].mute = !p.tracks[app.sel].mute;
      break;
    case 'ArrowUp': app.sel = clamp(app.sel - 1, 0, p.tracks.length - 1); break;
    case 'ArrowDown': app.sel = clamp(app.sel + 1, 0, p.tracks.length - 1); break;
    case 'ArrowLeft': selectPattern((app.pat + NUM_PATTERNS - 1) % NUM_PATTERNS); break;
    case 'ArrowRight': selectPattern((app.pat + 1) % NUM_PATTERNS); break;
    case 'KeyV': app.perform = false; setView(!p.songMode); break;
    case 'KeyP': app.perform = !app.perform; break;
    case 'Minus': p.bpm = clamp(p.bpm - (e.shiftKey ? 10 : 1), 40, 240); break;
    case 'Equal': p.bpm = clamp(p.bpm + (e.shiftKey ? 10 : 1), 40, 240); break;
    case 'KeyZ': app.octave = clamp(app.octave - 1, -3, 3); break;
    case 'KeyX': app.octave = clamp(app.octave + 1, -3, 3); break;
    case 'BracketLeft': case 'BracketRight': {
      const i = TABS.findIndex((t) => t.id === app.tab);
      app.tab = TABS[(i + (e.code === 'BracketLeft' ? TABS.length - 1 : 1)) % TABS.length].id;
      break;
    }
    case 'Backspace': case 'Delete':
      if (e.shiftKey) clearTrack(app.sel);
      else if (app.clip && p.songMode) deleteClip(app.clip);
      else return;
      break;
    case 'KeyC': if (e.shiftKey) cycleTheme(); else return; break;
    case 'Slash': if (e.shiftKey) app.modal = 'help'; else return; break;
    default: return;
  }
  e.preventDefault();
}

export function onKeyUp(e: KeyboardEvent): void {
  // a focused button would otherwise "click" when Space is released
  if (e.code === 'Space' && !typing(e) && !app.modal) e.preventDefault();
  const release = down.get(e.code);
  if (release) {
    down.delete(e.code);
    release();
  }
}

/** Let go of everything, e.g. when the window loses focus mid-note. */
export function releaseAll(): void {
  for (const release of down.values()) release();
  down.clear();
}
