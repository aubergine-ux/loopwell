// Compressed exports. The MP3 (LAME) and Ogg Vorbis encoders are WebAssembly
// and only fetched the first time one is used, so they cost nothing at startup.

export type Codec = 'mp3' | 'ogg';
export const CODECS: Record<Codec, { mime: 'audio/mpeg' | 'audio/ogg'; ext: string; label: string }> = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3', label: 'MP3' },
  ogg: { mime: 'audio/ogg', ext: 'ogg', label: 'OGG' },
};

/** 0 = smaller file, 1 = standard, 2 = best. */
export const QUALITY_LABELS = ['Small', 'Standard', 'Best'];
const MP3_KBPS = [128, 192, 320];
const OGG_QUALITY = [3, 5, 8];

/**
 * Encode stereo audio. `wasm` is the encoder's WebAssembly: its URL in the browser, or the bytes themselves.
 * (The library also carries both encoders inside its JavaScript; asking for them this way keeps that copy out of the build.)
 */
export async function encodeAudio(
  codec: Codec, l: Float32Array, r: Float32Array, sampleRate: number, quality: number,
  wasm: string | BufferSource, onProgress?: (done: number) => void | Promise<void>,
): Promise<Uint8Array<ArrayBuffer>> {
  const { createEncoder } = await import('wasm-media-encoders');
  const encoder = await createEncoder(CODECS[codec].mime, wasm);
  const q = Math.max(0, Math.min(2, Math.round(quality)));
  if (codec === 'mp3') encoder.configure({ sampleRate, channels: 2, bitrate: MP3_KBPS[q] as never });
  else encoder.configure({ sampleRate, channels: 2, vbrQuality: OGG_QUALITY[q] });

  let out = new Uint8Array(Math.max(1 << 16, Math.round(l.length / 4)));
  let n = 0;
  const add = (part: Uint8Array) => {
    if (n + part.length > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, n + part.length));
      bigger.set(out.subarray(0, n));
      out = bigger;
    }
    out.set(part, n); // the encoder owns `part` and will overwrite it, so it is copied straight away
    n += part.length;
  };
  const CHUNK = sampleRate; // a second at a time keeps a progress bar moving
  for (let pos = 0; pos < l.length; pos += CHUNK) {
    const end = Math.min(l.length, pos + CHUNK);
    add(encoder.encode([l.subarray(pos, end), r.subarray(pos, end)]));
    if (onProgress) await onProgress(end / l.length);
  }
  add(encoder.finalize());
  return out.slice(0, n);
}
