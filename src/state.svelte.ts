import { emptyProject, type Project } from './core/types';

export type Tab = 'sound' | 'keys' | 'rack' | 'mix' | 'fx' | 'song';
export type ModalName = 'share' | 'export' | 'help' | 'demos' | 'presets' | 'community';

export const THEMES = [
  { id: 'cream', name: 'Cream' },
  { id: 'night', name: 'Night' },
  { id: 'slate', name: 'Slate' },
  { id: 'arcade', name: 'Arcade' },
];

export const TABS: { id: Tab; label: string }[] = [
  { id: 'sound', label: 'Sound' },
  { id: 'keys', label: 'Keys' },
  { id: 'rack', label: 'Rack' },
  { id: 'mix', label: 'Mix' },
  { id: 'fx', label: 'FX' },
  { id: 'song', label: 'Song' },
];

/** Everything the interface reads. `project` is the beat; the rest is view state. */
export const app = $state({
  project: emptyProject() as Project,
  sel: 0, // selected track
  pat: 0, // pattern being shown and edited
  tab: 'sound' as Tab,
  playing: false,
  rec: false,
  queued: -1, // pattern waiting for the bar line
  /** Where the song starts playing from, in steps (the timeline cursor). */
  cursor: 0,
  /** Selected clip on the timeline. */
  clip: null as string | null,
  theme: 'cream',
  modal: null as ModalName | null,
  toast: null as { msg: string; kind: 'info' | 'error'; id: number } | null,
  /** A shared beat is loaded and waiting for the tap browsers require before sound. */
  needsTap: false,
  midi: { state: 'off' as 'off' | 'on' | 'denied' | 'unsupported', inputs: [] as string[] },
  /** Names of custom samples that are loaded, by id. */
  userSamples: {} as Record<string, string>,
  /** A take being recorded from the microphone, and the track it will land on. */
  recording: null as { track: number; seconds: number } | null,
  busy: null as { label: string; progress: number } | null,
  octave: 0, // computer-keyboard octave shift
  canUndo: false,
  canRedo: false,
});
