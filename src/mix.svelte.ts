// Mixing: groups, and the reference track.

import { toast, transportHooks } from './actions.svelte';
import { audio } from './audio/host';
import { METER_CHANNELS } from './core/engine';
import { SILENT, integratedLoudness } from './core/loudness';
import { MAX_BUSES, newBus } from './core/types';
import { app } from './state.svelte';

// --- groups ----------------------------------------------------------------

export function addBus(): number {
  const p = app.project;
  if (p.buses.length >= MAX_BUSES) return -1;
  p.buses.push(newBus(p.buses.length + 1));
  return p.buses.length - 1;
}

/** Remove a group. Its tracks go back to the master. */
export function removeBus(k: number): void {
  const p = app.project;
  if (!p.buses[k]) return;
  p.buses.splice(k, 1);
  for (const t of p.tracks) {
    if (t.bus === k + 1) t.bus = 0;
    else if (t.bus > k + 1) t.bus--;
  }
  if (app.rackBus === k) app.rackBus = -1;
  else if (app.rackBus > k) app.rackBus--;
}

/** Send a track to a group (1 and up), making the group if it is the next one along, or back to the master (0). */
export function routeTrack(t: number, bus: number): void {
  const p = app.project;
  if (!p.tracks[t]) return;
  if (bus === p.buses.length + 1 && addBus() < 0) return;
  if (bus < 0 || bus > p.buses.length) return;
  p.tracks[t].bus = bus;
}

// --- reference track -------------------------------------------------------

export const reference = $state({
  name: '',
  /** Integrated loudness of the reference, LUFS. */
  lufs: SILENT,
  seconds: 0,
  /** True while the reference is what is being heard. */
  on: false,
  /** How far the reference is being turned up or down to match, dB. */
  trim: 0,
  loading: false,
});

/** Loudness of the mix, to match the reference to: what has been measured since play was pressed, or failing that the last few seconds. */
function mixLoudness(): number {
  const l = audio.loudness;
  if (!l) return SILENT;
  const integrated = l[METER_CHANNELS + 1], short = l[METER_CHANNELS];
  return integrated > SILENT ? integrated : short;
}

export async function loadReference(file: File): Promise<boolean> {
  if (file.size > 80 * 1024 * 1024) { toast(`${file.name} is too big for a reference (80 MB max).`, 'error'); return false; }
  reference.loading = true;
  try {
    const got = await audio.loadReference(await file.arrayBuffer());
    if (!got) { toast(`Couldn't read ${file.name} as audio.`, 'error'); return false; }
    reference.on = false;
    reference.name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
    reference.seconds = got.seconds;
    // measured over at most the first five minutes, which is plenty to know how loud a song is
    const n = Math.min(got.l.length, Math.round(got.sampleRate * 300));
    reference.lufs = integratedLoudness(got.l.subarray(0, n), got.r?.subarray(0, n), got.sampleRate);
    if (app.playing) audio.startReference();
    return true;
  } finally {
    reference.loading = false;
  }
}

export function clearReference(): void {
  audio.clearReference();
  reference.name = '';
  reference.on = false;
  reference.lufs = SILENT;
}

/** Listen to the reference (true) or the mix (false). The reference is turned to the loudness of the mix, never the other way round. */
export function listenTo(ref: boolean): void {
  if (!reference.name) return;
  const mix = mixLoudness();
  // with nothing measured yet (the beat hasn't played), leave the reference as it is
  const db = mix > SILENT && reference.lufs > SILENT ? Math.max(-40, Math.min(12, mix - reference.lufs)) : 0;
  reference.trim = db;
  reference.on = ref;
  void audio.resume().then(() => audio.listen(ref, Math.pow(10, db / 20)));
}

// the reference runs alongside the transport, so switching to it lands at the same point in the song each time
transportHooks.push((playing) => {
  if (!reference.name) return;
  if (playing) { audio.resetLoudness(); audio.startReference(); }
  else if (!reference.on) audio.stopReference();
});
