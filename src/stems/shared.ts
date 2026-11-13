// What the page and the stem-separation worker say to each other. Kept apart from the worker itself so that
// the page can know these without pulling the neural-network runtime into what it loads at startup.

export const STEMS = ['drums', 'bass', 'other', 'vocals'] as const;
export type Stem = (typeof STEMS)[number];
export const STEM_NAMES: Record<Stem, string> = { drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals' };

/** The sample rate the model was trained at. Audio is converted to it going in and back coming out. */
export const MODEL_RATE = 44100;
/** HT-Demucs (Meta AI, MIT licence) as an ONNX graph, about 180 MB. Fetched once, then kept by the browser. */
export const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
export const MODEL_MB = 180;
/** The longest stretch that is separated at once: it is also the longest sample a track can hold. */
export const MAX_SECONDS = 30;

export type ToStems =
  | { t: 'split'; l: Float32Array; r: Float32Array; modelUrl: string }
  | { t: 'forget' };

export type FromStems =
  | { t: 'stage'; stage: 'model' | 'starting' | 'splitting'; backend?: string }
  | { t: 'download'; loaded: number; total: number }
  | { t: 'progress'; done: number; segment: number; segments: number }
  | { t: 'done'; stems: Record<Stem, { l: Float32Array; r: Float32Array }>; backend: string; seconds: number }
  | { t: 'error'; message: string };
