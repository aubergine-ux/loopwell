/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module 'demucs-web' {
  export const CONSTANTS: { SAMPLE_RATE: number; TRAINING_SAMPLES: number; DEFAULT_MODEL_URL: string; TRACKS: string[] };
  export class DemucsProcessor {
    constructor(options: { ort: unknown; sessionOptions?: object; onProgress?: (p: { progress: number; currentSegment: number; totalSegments: number }) => void; onLog?: (phase: string, message: string) => void });
    loadModel(model: string | ArrayBuffer): Promise<unknown>;
    separate(left: Float32Array, right: Float32Array): Promise<Record<string, { left: Float32Array; right: Float32Array }>>;
  }
}
