// Everything Loopwell can be told to do, in one list. The keyboard shortcuts,
// the cheat sheet and the command palette are all made from it, so they can
// never disagree, and any command can be given a different key.

import {
  addTrack, autoMaster, clearPattern, clearTrack, cycleTheme, exportAudio, exportMidiFile, exportStems, redo, removeTrack, saveProjectFile, selectPattern,
  setSteps, setTheme, setView, tapTempo, toast, togglePlay, undo, useKit, useSample,
} from './actions.svelte';
import { applyEuclid, randomizePattern, randomizeSound, randomizeTrack } from './creative.svelte';
import { GROOVES } from './core/creative';
import { DEMOS } from './core/demos';
import { KITS } from './core/kits';
import { PRESETS } from './core/presets';
import { NOTE_NAMES, SCALES } from './core/scales';
import { MAX_TRACKS, NUM_PATTERNS, PATTERN_NAMES, clamp, isPitched, usesNotes } from './core/types';
import { fitLoopToSong, startTap, toggleHum } from './ideas.svelte';
import { entries } from './library.svelte';
import { setLearning } from './midimap.svelte';
import { addBus } from './mix.svelte';
import { releaseAll, toggleRecording } from './perform.svelte';
import { prefs, setPref } from './prefs.svelte';
import { createProject, library, openAsNew, openProject, saveVersion } from './projects.svelte';
import { applyPreset } from './sound.svelte';
import { deleteClip, duplicateClip } from './song.svelte';
import { TABS, THEMES, app, type ModalName, type Tab } from './state.svelte';
import { startTour } from './tour.svelte';
import { loadText, saveText } from './storage';

export interface Command {
  id: string;
  title: string;
  group: string;
  /** Default shortcut, e.g. "Space", "Shift+KeyM", "Mod+KeyK" (Mod is Ctrl, or Cmd on a Mac). */
  keys?: string;
  /** Extra words the palette should match on. */
  words?: string;
  run: () => void;
  /** Leave it out of the palette for now (it wouldn't do anything). */
  when?: () => boolean;
}

const sel = () => app.project.tracks[app.sel];
const screen = (pads: boolean, live: boolean, song?: boolean) => () => {
  app.perform = pads; app.stage = live;
  if (song !== undefined) setView(song);
};
const open = (m: ModalName) => () => { app.modal = m; };
const tab = (t: Tab) => () => { app.perform = app.stage = false; app.tab = t; };
const bpm = (d: number) => () => { app.project.bpm = clamp(app.project.bpm + d, 40, 240); };

/** The fixed commands: the ones that can have a shortcut. */
export const COMMANDS: Command[] = [
  { id: 'play', title: 'Play / stop', group: 'Transport', keys: 'Space', run: togglePlay },
  { id: 'rec', title: 'Record what you play into the pattern', group: 'Transport', keys: 'KeyR', run: () => { app.rec = !app.rec; } },
  { id: 'tap', title: 'Tap tempo', group: 'Transport', keys: 'KeyT', run: tapTempo },
  { id: 'bpm-', title: 'Tempo down', group: 'Transport', keys: 'Minus', run: bpm(-1) },
  { id: 'bpm+', title: 'Tempo up', group: 'Transport', keys: 'Equal', run: bpm(1) },
  { id: 'bpm--', title: 'Tempo down by 10', group: 'Transport', keys: 'Shift+Minus', run: bpm(-10) },
  { id: 'bpm++', title: 'Tempo up by 10', group: 'Transport', keys: 'Shift+Equal', run: bpm(10) },
  { id: 'metronome', title: 'Metronome on / off', group: 'Transport', keys: 'KeyC', words: 'click', run: () => setPref('metronome', !prefs.metronome) },
  { id: 'countin', title: 'Count-in before recording: off, 1 bar, 2 bars', group: 'Transport', run: () => { setPref('countIn', (prefs.countIn + 1) % 3); toast(prefs.countIn ? `Count-in: ${prefs.countIn} bar${prefs.countIn > 1 ? 's' : ''} before recording` : 'Count-in off'); } },
  { id: 'loop-half', title: 'Loop the first two beats', group: 'Transport', words: 'region range', when: () => !app.project.songMode, run: () => { app.range = { from: 0, to: 8 }; } },
  { id: 'loop-bar', title: 'Loop the first bar', group: 'Transport', words: 'region range', when: () => !app.project.songMode && app.project.steps === 32, run: () => { app.range = { from: 0, to: 16 }; } },
  { id: 'loop-clear', title: 'Loop the whole pattern again', group: 'Transport', words: 'region range', when: () => !!app.range, run: () => { app.range = null; } },

  { id: 'undo', title: 'Undo', group: 'Edit', keys: 'Mod+KeyZ', run: undo },
  { id: 'redo', title: 'Redo', group: 'Edit', keys: 'Mod+Shift+KeyZ', run: redo },
  { id: 'redo2', title: 'Redo (alternative)', group: 'Edit', keys: 'Mod+KeyY', run: redo },
  { id: 'history', title: 'History: every step, and jump to any of them', group: 'Edit', keys: 'Shift+KeyH', run: open('history') },
  { id: 'clear-track', title: 'Clear the selected track in this pattern', group: 'Edit', keys: 'Shift+Backspace', run: () => clearTrack(app.sel) },
  { id: 'clear-pattern', title: 'Clear the whole pattern', group: 'Edit', run: () => clearPattern() },
  { id: 'clip-delete', title: 'Delete the selected clip', group: 'Edit', keys: 'Delete', when: () => !!app.clip && app.project.songMode, run: () => { if (app.clip) deleteClip(app.clip); } },
  { id: 'clip-delete2', title: 'Delete the selected clip (alternative)', group: 'Edit', keys: 'Backspace', when: () => !!app.clip && app.project.songMode, run: () => { if (app.clip) deleteClip(app.clip); } },
  { id: 'clip-dup', title: 'Duplicate the selected clip', group: 'Edit', keys: 'Mod+KeyD', when: () => !!app.clip && app.project.songMode, run: () => { if (app.clip) duplicateClip(app.clip); } },

  { id: 'track-up', title: 'Select the track above', group: 'Tracks', keys: 'ArrowUp', run: () => { app.sel = clamp(app.sel - 1, 0, app.project.tracks.length - 1); } },
  { id: 'track-down', title: 'Select the track below', group: 'Tracks', keys: 'ArrowDown', run: () => { app.sel = clamp(app.sel + 1, 0, app.project.tracks.length - 1); } },
  { id: 'mute', title: 'Mute the selected track', group: 'Tracks', keys: 'KeyM', run: () => { sel().mute = !sel().mute; } },
  { id: 'solo', title: 'Solo the selected track', group: 'Tracks', keys: 'Shift+KeyM', run: () => { sel().solo = !sel().solo; } },
  { id: 'add-drum', title: 'Add a drum track', group: 'Tracks', when: () => app.project.tracks.length < MAX_TRACKS, run: () => addTrack('drum') },
  { id: 'add-synth', title: 'Add a synth track', group: 'Tracks', when: () => app.project.tracks.length < MAX_TRACKS, run: () => addTrack('synth') },
  { id: 'add-808', title: 'Add an 808 bass track', group: 'Tracks', when: () => app.project.tracks.length < MAX_TRACKS, run: () => addTrack('bass') },
  { id: 'add-dsyn', title: 'Add a drum synth track', group: 'Tracks', words: 'knobs', when: () => app.project.tracks.length < MAX_TRACKS, run: () => addTrack('dsyn') },
  { id: 'remove-track', title: 'Delete the selected track', group: 'Tracks', when: () => app.project.tracks.length > 1, run: () => removeTrack(app.sel) },
  { id: 'add-group', title: 'Add a mixer group', group: 'Tracks', words: 'bus', run: () => { addBus(); app.tab = 'mix'; } },

  { id: 'pat-prev', title: 'Previous pattern', group: 'Patterns', keys: 'ArrowLeft', run: () => selectPattern((app.pat + NUM_PATTERNS - 1) % NUM_PATTERNS) },
  { id: 'pat-next', title: 'Next pattern', group: 'Patterns', keys: 'ArrowRight', run: () => selectPattern((app.pat + 1) % NUM_PATTERNS) },
  { id: 'steps-16', title: '16 steps', group: 'Patterns', run: () => setSteps(16) },
  { id: 'steps-32', title: '32 steps', group: 'Patterns', run: () => setSteps(32) },
  { id: 'hum', title: 'Hum a melody into notes', group: 'Patterns', words: 'sing microphone pitch', when: () => isPitched(sel().kind), run: () => { app.perform = app.stage = false; app.tab = 'keys'; toggleHum(); } },
  { id: 'tap-rhythm', title: 'Tap a rhythm into a drum pattern', group: 'Patterns', when: () => !usesNotes(sel().kind), run: () => { app.perform = app.stage = false; app.tab = 'tools'; startTap(); } },
  { id: 'fit-loop', title: 'Fit the track\'s loop to the song\'s tempo', group: 'Patterns', words: 'slice bpm audio', when: () => sel().kind === 'drum' || sel().kind === 'slice', run: () => void fitLoopToSong() },
  { id: 'euclid', title: 'Euclidean rhythm on the selected track: 5 hits over 16', group: 'Patterns', run: () => applyEuclid(app.sel, 16, 5, 0) },
  { id: 'dice-pattern', title: 'Roll the dice: a new pattern on every unlocked track', group: 'Patterns', words: 'random randomize', run: () => { randomizePattern(); } },
  { id: 'dice-track', title: 'Roll the dice: a new part for the selected track', group: 'Patterns', words: 'random randomize', run: () => randomizeTrack() },
  { id: 'dice-sound', title: 'Roll the dice: a new sound for the selected track', group: 'Patterns', words: 'random randomize', when: () => sel().kind !== 'slice', run: () => randomizeSound() },

  { id: 'view-toggle', title: 'Switch between pattern view and song view', group: 'View', keys: 'KeyV', run: () => { app.perform = app.stage = false; setView(!app.project.songMode); } },
  { id: 'view-pattern', title: 'Pattern view', group: 'View', run: screen(false, false, false) },
  { id: 'view-song', title: 'Song view: the timeline', group: 'View', words: 'arrange arrangement', run: screen(false, false, true) },
  { id: 'view-pads', title: 'Pads view', group: 'View', keys: 'KeyP', run: () => { app.stage = false; app.perform = !app.perform; } },
  { id: 'view-live', title: 'Live view: clip launcher and effect pad', group: 'View', keys: 'Shift+KeyP', words: 'launchpad scenes perform', run: () => { app.perform = false; app.stage = !app.stage; if (app.stage) setView(false); } },
  { id: 'tab-prev', title: 'Previous panel', group: 'View', keys: 'BracketLeft', run: () => stepTab(-1) },
  { id: 'tab-next', title: 'Next panel', group: 'View', keys: 'BracketRight', run: () => stepTab(1) },
  ...TABS.map((t): Command => ({ id: `tab-${t.id}`, title: `${t.label} panel`, group: 'View', run: tab(t.id) })),
  { id: 'theme', title: 'Next colour theme', group: 'View', keys: 'Shift+KeyC', run: cycleTheme },
  { id: 'octave-', title: 'Keyboard octave down', group: 'Playing', keys: 'KeyZ', run: () => { app.octave = clamp(app.octave - 1, -3, 3); } },
  { id: 'octave+', title: 'Keyboard octave up', group: 'Playing', keys: 'KeyX', run: () => { app.octave = clamp(app.octave + 1, -3, 3); } },
  { id: 'live-rec', title: 'Record a live performance to the song', group: 'Playing', run: () => { app.perform = false; app.stage = true; toggleRecording(); } },
  { id: 'live-release', title: 'Live: release every launched clip', group: 'Playing', run: releaseAll },
  { id: 'midi-learn', title: 'MIDI learn: tie a control to your controller', group: 'Playing', when: () => app.midi.state === 'on', run: () => setLearning(true) },

  { id: 'palette', title: 'Find anything: actions, sounds, settings', group: 'Loopwell', keys: 'Mod+KeyK', run: open('palette') },
  { id: 'help', title: 'Shortcuts and help', group: 'Loopwell', keys: 'Shift+Slash', words: 'cheat sheet keys', run: open('help') },
  { id: 'templates', title: 'Start from a template: trap, house, boom bap, lo-fi, drill', group: 'Loopwell', words: 'genre starter', run: () => { app.beats = 'templates'; app.modal = 'demos'; } },
  { id: 'beats', title: 'Your beats, demos and templates', group: 'Loopwell', keys: 'Mod+KeyO', words: 'projects open browser', run: open('demos') },
  { id: 'new', title: 'New beat', group: 'Loopwell', run: () => void createProject() },
  { id: 'save-version', title: 'Save a version of this beat', group: 'Loopwell', keys: 'Mod+KeyS', words: 'snapshot', run: () => void saveVersion() },
  { id: 'share', title: 'Share this beat as a link', group: 'Loopwell', run: open('share') },
  { id: 'sounds', title: 'Browse sounds', group: 'Loopwell', words: 'samples library', run: open('samples') },
  { id: 'stems', title: 'Split a song into stems: drums, bass, vocals, other', group: 'Loopwell', words: 'separate separation demucs acapella instrumental', run: open('stems') },
  { id: 'presets', title: 'Synth presets', group: 'Loopwell', run: open('presets') },
  { id: 'midi', title: 'MIDI controllers and mappings', group: 'Loopwell', run: open('midi') },
  { id: 'community', title: 'Community: gallery, cloud saves, sample packs', group: 'Loopwell', run: open('community') },
  { id: 'master', title: 'Master the song: set its loudness', group: 'Export', words: 'mastering limiter lufs loud', run: () => { app.perform = app.stage = false; app.tab = 'master'; void autoMaster(); } },
  { id: 'export', title: 'Export…', group: 'Export', run: open('export') },
  { id: 'export-wav', title: 'Export WAV', group: 'Export', run: () => void exportAudio('wav') },
  { id: 'export-mp3', title: 'Export MP3', group: 'Export', run: () => void exportAudio('mp3', 'stream') },
  { id: 'export-ogg', title: 'Export OGG', group: 'Export', run: () => void exportAudio('ogg', 'stream') },
  { id: 'export-stems', title: 'Export stems', group: 'Export', run: () => void exportStems() },
  { id: 'export-midi', title: 'Export MIDI', group: 'Export', run: exportMidiFile },
  { id: 'export-project', title: 'Save a project file', group: 'Export', run: saveProjectFile },
  { id: 'tips', title: 'Tooltips on / off', group: 'Settings', words: 'hints help', run: () => { setPref('tips', !prefs.tips); toast(prefs.tips ? 'Tooltips on' : 'Tooltips off'); } },
  { id: 'calm', title: 'Reduce motion on / off', group: 'Settings', words: 'animation', run: () => { setPref('calm', !prefs.calm); toast(prefs.calm ? 'Less motion' : 'Full motion'); } },
  { id: 'tour', title: 'Show the walkthrough again', group: 'Settings', words: 'tutorial onboarding', run: () => void startTour() },
];

function stepTab(d: number): void {
  const i = TABS.findIndex((t) => t.id === app.tab);
  app.tab = TABS[(i + d + TABS.length) % TABS.length].id;
}

/** Things to find that come from data rather than from the list above: sounds, presets, beats, themes, keys. */
function found(): Command[] {
  const out: Command[] = [];
  const p = app.project, t = sel();
  for (const th of THEMES) out.push({ id: `theme:${th.id}`, title: `Theme: ${th.name}`, group: 'Settings', run: () => setTheme(th.id) });
  p.tracks.forEach((tr, i) => out.push({ id: `track:${i}`, title: `Go to track ${i + 1}: ${tr.name}`, group: 'Tracks', run: () => { app.sel = i; } }));
  for (let i = 0; i < NUM_PATTERNS; i++) out.push({ id: `pat:${i}`, title: `Pattern ${PATTERN_NAMES[i]}`, group: 'Patterns', run: () => selectPattern(i) });
  for (const k of KITS) out.push({ id: `kit:${k.id}`, title: `Kit: ${k.name} on every drum track`, group: 'Sounds', words: k.blurb, run: () => useKit(k.id) });
  for (const e of entries()) {
    out.push({ id: `sound:${e.id}`, title: `Sound: ${e.name} (${e.source})`, group: 'Sounds', words: e.auto.join(' '), run: () => useSample(app.sel, e.id) });
  }
  if (t.kind === 'synth') for (const x of PRESETS) out.push({ id: `preset:${x.group}/${x.name}`, title: `Preset: ${x.name} (${x.group})`, group: 'Sounds', run: () => applyPreset(app.sel, x) });
  GROOVES.forEach((g, i) => out.push({ id: `groove:${i}`, title: `Groove: ${g.name}`, group: 'Settings', words: `${g.blurb} swing feel`, run: () => { p.groove = i; } }));
  NOTE_NAMES.forEach((n, i) => out.push({ id: `key:${i}`, title: `Key: ${n}`, group: 'Settings', words: 'root scale', run: () => { p.scaleRoot = i; } }));
  SCALES.forEach((s, i) => out.push({ id: `scale:${i}`, title: `Scale: ${s.name}`, group: 'Settings', words: 'key', run: () => { p.scaleType = i; } }));
  DEMOS.forEach((d, i) => out.push({ id: `demo:${i}`, title: `Demo: ${d.name}`, group: 'Beats', words: d.blurb, run: () => void openAsNew(DEMOS[i].make()) }));
  for (const b of library.list) if (b.id !== library.current) out.push({ id: `beat:${b.id}`, title: `Open beat: ${b.name}`, group: 'Beats', run: () => void openProject(b.id) });
  if (usesNotes(t.kind)) out.push({ id: 'keys', title: `Draw notes for ${t.name}`, group: 'View', words: 'piano roll', run: tab('keys') });
  return out;
}

/**
 * How well `query` matches `text`: every letter has to appear in order. Runs of letters and the starts of words
 * count for more, so "exmp" finds "Export MP3" ahead of things that merely contain those letters. 0 = no match.
 */
export function fuzzy(query: string, text: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return fuzzyWord(words[0] ?? '', text);
  // several words can come in any order ("dust snare" finds "snare (Dust)"), but each has to be found
  let total = 0;
  for (const w of words) {
    const s = fuzzyWord(w, text);
    if (s <= 0) return 0;
    total += s;
  }
  return total;
}

function fuzzyWord(q: string, text: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  let score = 0, at = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return 0;
    const wordStart = i === 0 || /[\s:(/-]/.test(t[i - 1]);
    run = i === at && at > 0 ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 4 : 0) - Math.min(3, (i - at) * 0.1);
    at = i + 1;
  }
  return Math.max(0.01, score + (t.startsWith(q) ? 10 : 0) - t.length * 0.01);
}

/** What the palette shows for what has been typed, best first. */
export function search(query: string, limit = 40): Command[] {
  const all = [...COMMANDS.filter((c) => !c.id.endsWith('2')), ...found()].filter((c) => !c.when || c.when());
  if (!query.trim()) return all.slice(0, limit);
  return all
    .map((c) => ({ c, s: Math.max(fuzzy(query, c.title), fuzzy(query, `${c.group} ${c.title}`) * 0.9, c.words ? fuzzy(query, c.words) * 0.7 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

// --- shortcuts -------------------------------------------------------------

const KEYS = 'loopwell:keys';

function loadKeys(): Record<string, string> {
  try {
    const raw = JSON.parse(loadText(KEYS) ?? '{}');
    const out: Record<string, string> = {};
    for (const id of Object.keys(raw ?? {})) if (typeof raw[id] === 'string' && COMMANDS.some((c) => c.id === id)) out[id] = raw[id];
    return out;
  } catch {
    return {};
  }
}

/** Shortcuts that have been changed, by command id. An empty string means "none". */
export const keymap = $state({ custom: loadKeys() });

export const keysFor = (c: Command): string => keymap.custom[c.id] ?? c.keys ?? '';

/** The combination a key event stands for, written the way shortcuts are stored. */
export function combo(e: KeyboardEvent): string {
  return `${e.ctrlKey || e.metaKey ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
}

export function commandFor(keys: string): Command | undefined {
  return COMMANDS.find((c) => keysFor(c) === keys);
}

/** Keys that play pads and notes. They can't be given to a command. */
const MUSICAL = /^(Digit[1-8]|Key[ASDFGHJKL]|Semicolon|Quote|Backslash)$/;
const PLAIN_ONLY = /^(Shift\+)?(Tab|Escape|Enter)$/;

/** Give a command a new shortcut ('' for none). Returns the title of the command that had it before, if one did. */
export function rebind(id: string, keys: string): { ok: boolean; why?: string; took?: string } {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) return { ok: false };
  if (keys && MUSICAL.test(keys)) return { ok: false, why: 'That key plays pads or notes.' };
  if (keys && PLAIN_ONLY.test(keys)) return { ok: false, why: 'That key is needed for getting around.' };
  const other = keys ? COMMANDS.find((x) => x.id !== id && keysFor(x) === keys) : undefined;
  if (other) keymap.custom[other.id] = '';
  if (keys === (c.keys ?? '')) delete keymap.custom[id]; else keymap.custom[id] = keys;
  saveText(KEYS, JSON.stringify(keymap.custom));
  return { ok: true, took: other?.title };
}

export function resetKeys(): void {
  keymap.custom = {};
  saveText(KEYS, '{}');
}

const NAMES: Record<string, string> = {
  Space: 'Space', Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']', Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: '\'',
  Backquote: '`', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: 'Backspace', Delete: 'Del', Enter: 'Enter', Escape: 'Esc',
};
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** A shortcut as it is shown to people: "Ctrl+Shift+Z", "?", "Space". */
export function keyLabel(keys: string): string {
  if (!keys) return '';
  if (keys === 'Shift+Slash') return '?';
  return keys.split('+').map((k) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : NAMES[k] ?? k.replace(/^Key|^Digit|^Numpad/, ''))).join('+');
}
