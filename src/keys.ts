// Computer-keyboard control. Uses physical key positions (event.code), so it
// works the same on any layout.

import { noteDown, noteUp, padDown, padUp } from './actions.svelte';
import { combo, commandFor } from './commands.svelte';
import { setFill } from './creative.svelte';
import { degreeToPitch } from './core/scales';
import { isPitched } from './core/types';
import { isLearning, setLearning } from './midimap.svelte';
import { app } from './state.svelte';

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
  if (e.key === 'Escape') {
    if (app.modal) app.modal = null;
    else if (isLearning()) setLearning(false);
    else if (app.tour >= 0) app.tour = -1;
    return;
  }
  const keys = combo(e);
  // the palette opens from anywhere, even while typing or with a dialog up
  const cmd = commandFor(keys);
  if (cmd?.id === 'palette') { e.preventDefault(); app.modal = app.modal === 'palette' ? null : 'palette'; return; }
  if (typing(e) || app.modal) return;
  if (e.repeat && !(cmd && REPEATS.has(cmd.id))) { if (down.has(e.code) || cmd) e.preventDefault(); return; }
  // keys that play come first, but only bare: with Ctrl or Alt held they are shortcuts
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && press(e.code)) { e.preventDefault(); return; }
  if (!cmd || (cmd.when && !cmd.when())) return;
  e.preventDefault();
  cmd.run();
}

/** Commands it makes sense to repeat while the key is held. */
const REPEATS = new Set(['bpm-', 'bpm+', 'bpm--', 'bpm++', 'track-up', 'track-down', 'undo', 'redo', 'redo2']);

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
