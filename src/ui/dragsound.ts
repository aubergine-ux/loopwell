// Dragging a sound from a dialog (the sample browser, the stems list) onto a track behind it.

import { app } from '../state.svelte';

export const SOUND_TYPE = 'application/x-loopwell-sample';

export function dragSound(e: DragEvent, id: string): void {
  e.dataTransfer?.setData(SOUND_TYPE, id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  // The dialog has to stay (taking the dragged thing away would cancel the drag), so it steps aside: faded, and
  // letting the pointer through to the tracks underneath. Done a moment later, because changing what is under
  // the pointer in the middle of starting a drag makes some browsers call the drag off.
  setTimeout(() => { document.documentElement.dataset.dragging = ''; });
}

export function dragSoundEnd(e: DragEvent): void {
  delete document.documentElement.dataset.dragging;
  if (e.dataTransfer?.dropEffect && e.dataTransfer.dropEffect !== 'none') app.modal = null; // it landed on a track
}
