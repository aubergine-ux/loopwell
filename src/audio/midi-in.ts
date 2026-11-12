// Web MIDI input. Pad controllers (channel 10, or any channel while a drum
// track is selected) hit the pads; keyboards play the selected synth track.

import { noteDown, noteUp, padDown, padUp, play, stop } from '../actions.svelte';
import { snapToScale } from '../core/scales';
import { app } from '../state.svelte';

const PAD_BASE = 36; // C1, where pad controllers start by default
const held = new Map<number, { track: number; pitch: number; pad: boolean }>();
let access: MIDIAccess | null = null;

function refresh(): void {
  if (!access) return;
  const names: string[] = [];
  access.inputs.forEach((input) => {
    input.onmidimessage = onMessage;
    if (input.state === 'connected') names.push(input.name ?? 'MIDI device');
  });
  app.midi.inputs = names;
}

function onMessage(e: MIDIMessageEvent): void {
  const d = e.data;
  if (!d || !d.length) return;
  const status = d[0];
  if (status === 0xfa || status === 0xfb) { void play(); return; }
  if (status === 0xfc) { stop(); return; }
  const type = status & 0xf0, ch = status & 15;
  const key = (ch << 7) | d[1];
  if (type === 0x90 && d[2] > 0) {
    const p = app.project;
    const sel = p.tracks[app.sel];
    const asPad = ch === 9 || sel?.kind !== 'synth';
    if (asPad) {
      const track = (((d[1] - PAD_BASE) % 8) + 8) % 8;
      if (track >= p.tracks.length) return;
      held.set(key, { track, pitch: 0, pad: true });
      padDown(track, d[2]);
    } else {
      const pitch = p.scaleLock ? snapToScale(d[1], p.scaleRoot, p.scaleType) : d[1];
      held.set(key, { track: app.sel, pitch, pad: false });
      noteDown(app.sel, pitch, d[2]);
    }
  } else if (type === 0x80 || (type === 0x90 && d[2] === 0)) {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    if (h.pad) padUp(h.track);
    else noteUp(h.track, h.pitch);
  } else if (type === 0xb0) {
    if (d[1] === 7) app.project.master = d[2];
    else if (d[1] === 1) app.project.fx.filter = d[2] - 64;
    else if (d[1] === 74 && app.project.tracks[app.sel]?.kind === 'synth') app.project.tracks[app.sel].synth.cutoff = d[2];
  }
}

/** Ask for MIDI access. Browsers show a permission prompt the first time. */
export async function connectMidi(): Promise<void> {
  if (!navigator.requestMIDIAccess) {
    app.midi.state = 'unsupported';
    return;
  }
  try {
    access = await navigator.requestMIDIAccess();
    access.onstatechange = refresh;
    app.midi.state = 'on';
    refresh();
  } catch {
    app.midi.state = 'denied';
  }
}

/** Connect silently if permission was already granted on an earlier visit. */
export async function autoConnectMidi(): Promise<void> {
  if (!navigator.requestMIDIAccess) {
    app.midi.state = 'unsupported';
    return;
  }
  try {
    const perm = await navigator.permissions.query({ name: 'midi' as PermissionName });
    if (perm.state === 'granted') await connectMidi();
  } catch { /* the permission can't be queried here; wait for the button */ }
}
