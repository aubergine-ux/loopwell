// Finding where the hits are in a sample, so it can be chopped onto pads.

export const MAX_SLICES = 32;

/**
 * Transient detection. Returns slice start frames (always beginning with 0),
 * at most MAX_SLICES of them. `sensitivity` 0..1: higher finds quieter hits.
 */
export function detectSlices(l: Float32Array, r: Float32Array | undefined, sampleRate: number, sensitivity = 0.5): number[] {
  const hop = Math.max(32, Math.round(sampleRate * 0.004));
  const frames = Math.floor(l.length / hop);
  if (frames < 4) return [0];
  // loudness per hop, in dB
  const db = new Float32Array(frames);
  let loudest = -120;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const x = r ? (l[i] + r[i]) * 0.5 : l[i];
      e += x * x;
    }
    db[f] = 10 * Math.log10(e / hop + 1e-12);
    if (db[f] > loudest) loudest = db[f];
  }
  // a hit is a jump in loudness over the recent past, well above the noise floor
  const rise = 12 - sensitivity * 9; // dB
  const floor = loudest - (30 + sensitivity * 20);
  const gap = Math.round((0.09 - sensitivity * 0.05) * sampleRate / hop);
  const found: { frame: number; strength: number }[] = [];
  let last = -gap;
  for (let f = 1; f < frames; f++) {
    let before = -120;
    for (let k = Math.max(0, f - 6); k < f; k++) before = Math.max(before, db[k]);
    const jump = db[f] - Math.min(before, Math.max(db[f - 1], before - 6));
    if (db[f] < floor || db[f] - before < rise * 0.25 || jump < rise || f - last < gap) continue;
    found.push({ frame: f, strength: jump });
    last = f;
  }
  let starts = found.filter((x) => x.frame > 0);
  if (starts.length > MAX_SLICES - 1) {
    starts = starts.sort((a, b) => b.strength - a.strength).slice(0, MAX_SLICES - 1).sort((a, b) => a.frame - b.frame);
  }
  const out = [0];
  for (const s of starts) {
    // the hop only says roughly where: find the sample where the hit actually starts ...
    const a = Math.max(1, (s.frame - 1) * hop), b = Math.min(l.length, (s.frame + 1) * hop);
    let top = 0;
    for (let k = a; k < b; k++) { const v = Math.abs(l[k]); if (v > top) top = v; }
    let i = a;
    while (i < b - 1 && Math.abs(l[i]) < top * 0.1) i++;
    // ... then back up to the zero crossing before it, so the slice doesn't begin with a click
    const stop = Math.max(1, i - 64);
    while (i > stop && (l[i] >= 0) === (l[i - 1] >= 0)) i--;
    if (i - out[out.length - 1] > hop * 2) out.push(i);
  }
  return out;
}

/** `count` slices of equal length. */
export function equalSlices(length: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.floor((i * length) / count));
}

/** Slice starts are stored as 0..65535 fractions of the sample, so they survive a different sample rate. */
export const toFraction = (frame: number, length: number) => Math.min(65535, Math.round((frame / Math.max(1, length)) * 65536));
export const toFrame = (fraction: number, length: number) => Math.min(length, Math.round((fraction / 65536) * length));
