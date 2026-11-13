// Stem separation: split a piece of audio into drums, bass, vocals and the
// rest, on this machine. The heavy part (the model and its runtime) lives in a
// worker that is only loaded the first time someone asks for a split.

import { hashId, registerSample, toast, useSample, addTrack } from './actions.svelte';
import { audio } from './audio/host';
import { MAX_TRACKS } from './core/types';
import { encodeWav } from './core/wav';
import { app } from './state.svelte';
import { MAX_SECONDS, MODEL_RATE, MODEL_URL, STEMS, STEM_NAMES, type FromStems, type Stem, type ToStems } from './stems/shared';

export interface Source {
  name: string;
  l: Float32Array;
  r: Float32Array;
  sampleRate: number;
  seconds: number;
}

export const stems = $state({
  /** The audio that was chosen, before it is split. */
  source: null as { name: string; seconds: number } | null,
  /** Where in the source the part to split starts, seconds. */
  from: 0,
  stage: 'idle' as 'idle' | 'reading' | 'model' | 'starting' | 'splitting' | 'saving' | 'done',
  /** 0..1 within the current stage. */
  progress: 0,
  detail: '',
  backend: '',
  /** Sample ids of the finished stems. */
  result: null as Record<Stem, string> | null,
  error: '',
});

let source: Source | null = null;
let worker: Worker | null = null;

export const stemsBusy = () => stems.stage !== 'idle' && stems.stage !== 'done';

/** Read an audio file ready to be split. */
export async function chooseStemSource(file: File): Promise<boolean> {
  if (stemsBusy()) return false;
  stems.error = '';
  stems.result = null;
  if (file.size > 300 * 1024 * 1024) { stems.error = `${file.name} is too big to read here (300 MB at most).`; return false; }
  stems.stage = 'reading';
  try {
    await audio.init();
    const buf = await audio.ctx!.decodeAudioData(await file.arrayBuffer());
    if (buf.duration < 0.5) throw new Error('short');
    source = { name: file.name.replace(/\.[a-z0-9]{2,5}$/i, ''), l: buf.getChannelData(0), r: buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0), sampleRate: buf.sampleRate, seconds: buf.duration };
    stems.source = { name: source.name, seconds: buf.duration };
    stems.from = 0;
    stems.stage = 'idle';
    return true;
  } catch (e) {
    source = null;
    stems.source = null;
    stems.stage = 'idle';
    stems.error = e instanceof Error && e.message === 'short' ? `${file.name} is too short to split.` : `Couldn't read ${file.name} as audio.`;
    return false;
  }
}

/** Change the sample rate of a stereo pair. Uses the browser's own converter, which filters properly. */
async function resample(l: Float32Array, r: Float32Array, from: number, to: number): Promise<[Float32Array, Float32Array]> {
  if (from === to) return [l, r];
  const frames = Math.max(1, Math.round((l.length * to) / from));
  const off = new OfflineAudioContext(2, frames, to);
  const buf = off.createBuffer(2, l.length, from);
  buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

/** Split the chosen audio (up to thirty seconds of it, from `stems.from`) into four stems and add them to the sample library. */
export async function splitStems(): Promise<void> {
  if (!source || stemsBusy()) return;
  const src = source;
  stems.error = '';
  stems.result = null;
  stems.progress = 0;
  stems.detail = '';
  stems.stage = 'model';
  try {
    const a = Math.round(Math.min(stems.from, Math.max(0, src.seconds - 0.5)) * src.sampleRate);
    const b = Math.min(src.l.length, a + Math.round(MAX_SECONDS * src.sampleRate));
    const [l, r] = await resample(src.l.slice(a, b), src.r.slice(a, b), src.sampleRate, MODEL_RATE);
    const done = await new Promise<Extract<FromStems, { t: 'done' }>>((resolve, reject) => {
      worker ??= new Worker(new URL('./stems/worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = (e) => reject(new Error(e.message || 'The separation engine could not start.'));
      worker.onmessage = (e: MessageEvent<FromStems>) => {
        const m = e.data;
        if (m.t === 'stage') { stems.stage = m.stage; stems.progress = 0; if (m.backend) stems.backend = m.backend; }
        else if (m.t === 'download') { stems.progress = m.total ? m.loaded / m.total : 0; stems.detail = `${Math.round(m.loaded / 1048576)} of ${Math.round((m.total || 0) / 1048576)} MB`; }
        else if (m.t === 'progress') { stems.progress = m.done; stems.detail = `part ${m.segment} of ${m.segments}`; }
        else if (m.t === 'error') reject(new Error(m.message));
        else resolve(m);
      };
      const msg: ToStems = { t: 'split', l, r, modelUrl: MODEL_URL };
      worker.postMessage(msg, [l.buffer, r.buffer]);
    });
    stems.stage = 'saving';
    stems.detail = '';
    stems.backend = done.backend;
    const ids = {} as Record<Stem, string>;
    for (const s of STEMS) {
      const [sl, sr] = await resample(done.stems[s].l, done.stems[s].r, MODEL_RATE, audio.sampleRate);
      const bytes = encodeWav([sl, sr], audio.sampleRate, 16);
      const id = hashId(bytes);
      if (!(await registerSample({ id, name: `${STEM_NAMES[s].toLowerCase()} (${src.name}).wav`, bytes }, true))) throw new Error('A stem could not be saved.');
      ids[s] = id;
    }
    stems.result = ids;
    stems.stage = 'done';
    stems.detail = `${done.seconds.toFixed(0)} s on ${done.backend}`;
  } catch (e) {
    stems.stage = 'idle';
    stems.error = navigator.onLine === false && !stems.backend
      ? 'The model has to be downloaded once before stems can be split offline. Connect and try again.'
      : `The split did not finish: ${e instanceof Error ? e.message : 'something went wrong'}`;
    // a worker that failed part-way may be in any state: start a fresh one next time
    worker?.terminate();
    worker = null;
  }
}

/** Stop a split that is running. */
export function cancelStems(): void {
  if (!stemsBusy()) return;
  worker?.terminate();
  worker = null;
  stems.stage = 'idle';
  stems.progress = 0;
  stems.detail = '';
}

/** Put a finished stem on a track: the selected one, or a new one. */
export function useStem(s: Stem, fresh = false): void {
  const id = stems.result?.[s];
  if (!id) return;
  if (fresh) {
    if (app.project.tracks.length >= MAX_TRACKS) { toast('All 8 tracks are in use.', 'error'); return; }
    addTrack('drum');
  }
  useSample(app.sel, id);
}

/** Free the 180 MB the model takes in the browser's storage. It is downloaded again the next time it is needed. */
export function forgetModel(): void {
  worker?.terminate();
  worker = null;
  void caches?.delete('loopwell-models');
  stems.backend = '';
  toast('The stem model has been removed from this browser.');
}
