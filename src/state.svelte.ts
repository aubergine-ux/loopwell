import { emptyProject, type Project } from './core/types';

export type Tab = 'sound' | 'keys' | 'mix' | 'fx' | 'song';
export type ModalName = 'share' | 'export' | 'help' | 'demos';

export const THEMES = [
  { id: 'cream', name: 'Cream' },
  { id: 'night', name: 'Night' },
  { id: 'slate', name: 'Slate' },
  { id: 'arcade', name: 'Arcade' },
];

export const TABS: { id: Tab; label: string }[] = [
  { id: 'sound', label: 'Sound' },
  { id: 'keys', label: 'Keys' },
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
  songPos: 0,
  theme: 'cream',
  modal: null as ModalName | null,
  toast: null as { msg: string; kind: 'info' | 'error'; id: number } | null,
  /** A shared beat is loaded and waiting for the tap browsers require before sound. */
  needsTap: false,
  midi: { state: 'off' as 'off' | 'on' | 'denied' | 'unsupported', inputs: [] as string[] },
  /** Names of custom samples that are loaded, by id. */
  userSamples: {} as Record<string, string>,
  busy: null as { label: string; progress: number } | null,
  octave: 0, // computer-keyboard octave shift
  canUndo: false,
  canRedo: false,
});
