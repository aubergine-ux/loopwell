// Settings that belong to this browser rather than to a beat.

import { audio } from './audio/host';
import { loadPrefs, savePrefs } from './storage';

const saved = loadPrefs();
const bool = (k: string, d: boolean) => (typeof saved[k] === 'boolean' ? (saved[k] as boolean) : d);
const num = (k: string, lo: number, hi: number, d: number) => (typeof saved[k] === 'number' && saved[k] >= lo && saved[k] <= hi ? Math.round(saved[k] as number) : d);

export const prefs = $state({
  /** Click on every beat while playing. */
  metronome: bool('metronome', false),
  /** Bars of count-in before a recording starts: 0, 1 or 2. */
  countIn: num('countIn', 0, 2, 1),
  /** Explain each control when it is hovered or focused. */
  tips: bool('tips', true),
  /** The first-run walkthrough has been finished or dismissed. */
  toured: bool('toured', false),
  /** Keep movement to a minimum, whatever the system setting says. */
  calm: bool('calm', false),
});

export function setPref<K extends keyof typeof prefs>(key: K, value: (typeof prefs)[K]): void {
  prefs[key] = value;
  savePrefs($state.snapshot(prefs));
  if (key === 'metronome') audio.setMetronome(prefs.metronome);
}

/** Send the settings the audio engine cares about. Call once at startup. */
export function applyPrefs(): void {
  audio.setMetronome(prefs.metronome);
}
