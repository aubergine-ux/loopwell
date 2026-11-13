// Loudness as people hear it (ITU-R BS.1770 / EBU R 128), in LUFS. Used for
// the meters, for matching a reference track to the mix, and for normalizing
// exports. Peak level says when something clips; this says how loud it sounds.

/** One biquad as [b0, b1, b2, a1, a2]. */
type Coefs = [number, number, number, number, number];

/** The two "K-weighting" filters: a high shelf for the head, then a high-pass for the lows the ear ignores. */
function kCoefs(sr: number): [Coefs, Coefs] {
  // the standard gives coefficients for 48 kHz; these are the same filters worked out for any rate
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Coefs = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const high: Coefs = [1 / a0, -2 / a0, 1 / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, high];
}

/** K-weights one channel as it goes by and adds up its energy. Allocates nothing after it is made. */
class KChannel {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private u1 = 0; private u2 = 0; private v1 = 0; private v2 = 0;
  constructor(private a: Coefs, private b: Coefs) {}

  /** Sum of squares of the weighted signal over `n` frames. */
  energy(x: Float32Array, n: number, from = 0): number {
    const [a0, a1, a2, a3, a4] = this.a, [b0, b1, b2, b3, b4] = this.b;
    let { x1, x2, y1, y2, u1, u2, v1, v2 } = this;
    let sum = 0;
    for (let i = from; i < from + n; i++) {
      const s = x[i];
      const y = a0 * s + a1 * x1 + a2 * x2 - a3 * y1 - a4 * y2;
      x2 = x1; x1 = s; y2 = y1; y1 = y;
      const v = b0 * y + b1 * u1 + b2 * u2 - b3 * v1 - b4 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      sum += v * v;
    }
    // denormals would make silence expensive
    if (Math.abs(y1) < 1e-25) y1 = y2 = 0;
    if (Math.abs(v1) < 1e-25) v1 = v2 = 0;
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2; this.u1 = u1; this.u2 = u2; this.v1 = v1; this.v2 = v2;
    return sum;
  }
}

const toLufs = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);
/** What a meter shows for silence. */
export const SILENT = -70;

/**
 * A running loudness meter for a stereo signal: "momentary" is the last 400 ms, "short-term" the last 3 s.
 * Feed it every block; it works in 100 ms slices.
 */
export class LoudnessMeter {
  private l: KChannel;
  private r: KChannel;
  private slice: number; // frames in 100 ms
  private filled = 0;
  private acc = 0;
  private ring = new Float32Array(30); // mean square of each of the last 30 slices
  private at = 0;
  private count = 0;
  /** Mean square of every 100 ms slice since reset, for an integrated reading. Capped at an hour. */
  private history: Float32Array | null;
  private hn = 0;

  constructor(sampleRate: number, keepHistory = false) {
    const [a, b] = kCoefs(sampleRate);
    this.l = new KChannel(a, b);
    this.r = new KChannel(a, b);
    this.slice = Math.round(sampleRate / 10);
    this.history = keepHistory ? new Float32Array(36000) : null;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    let from = 0;
    while (from < n) {
      const take = Math.min(n - from, this.slice - this.filled);
      this.acc += this.l.energy(L, take, from) + this.r.energy(R, take, from);
      this.filled += take;
      from += take;
      if (this.filled === this.slice) {
        const ms = this.acc / this.slice;
        this.ring[this.at] = ms;
        this.at = (this.at + 1) % this.ring.length;
        if (this.count < this.ring.length) this.count++;
        if (this.history && this.hn < this.history.length) this.history[this.hn++] = ms;
        this.acc = 0;
        this.filled = 0;
      }
    }
  }

  private mean(slices: number): number {
    const n = Math.min(slices, this.count);
    if (!n) return 0;
    let s = 0;
    for (let i = 1; i <= n; i++) s += this.ring[(this.at - i + this.ring.length) % this.ring.length];
    return s / n;
  }

  get momentary(): number { return Math.max(SILENT, toLufs(this.mean(4))); }
  get shortTerm(): number { return Math.max(SILENT, toLufs(this.mean(30))); }
  /** Loudness of everything since reset, with the quiet parts left out as the standard says. */
  get integrated(): number { return this.history ? gated(this.history, this.hn) : SILENT; }

  reset(): void {
    this.ring.fill(0);
    this.count = this.at = this.hn = 0;
    this.acc = this.filled = 0;
  }
}

/** Integrated loudness from 100 ms slice energies: 400 ms blocks, 75% overlap, an absolute gate at -70 and a relative one 10 below the rest. */
function gated(slices: Float32Array, n: number): number {
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= n; i++) blocks.push((slices[i] + slices[i + 1] + slices[i + 2] + slices[i + 3]) / 4);
  if (!blocks.length) {
    // shorter than one block: all of it counts
    let s = 0;
    for (let i = 0; i < n; i++) s += slices[i];
    return n ? Math.max(SILENT, toLufs(s / n)) : SILENT;
  }
  const loud = blocks.filter((b) => toLufs(b) > -70);
  if (!loud.length) return SILENT;
  const rel = toLufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((b) => toLufs(b) > rel);
  return kept.length ? toLufs(kept.reduce((a, b) => a + b, 0) / kept.length) : SILENT;
}

/** Integrated loudness of a whole piece of audio, in LUFS (-70 for silence). */
export function integratedLoudness(l: Float32Array, r: Float32Array | undefined, sampleRate: number): number {
  const m = new LoudnessMeter(sampleRate, true);
  const right = r ?? l;
  const CHUNK = 1 << 15;
  for (let pos = 0; pos < l.length; pos += CHUNK) {
    const n = Math.min(CHUNK, l.length - pos);
    m.process(l.subarray(pos, pos + n), right.subarray(pos, pos + n), n);
  }
  return m.integrated;
}

export function samplePeak(l: Float32Array, r?: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < l.length; i++) { const a = l[i] < 0 ? -l[i] : l[i]; if (a > peak) peak = a; }
  if (r && r !== l) for (let i = 0; i < r.length; i++) { const a = r[i] < 0 ? -r[i] : r[i]; if (a > peak) peak = a; }
  return peak;
}

export const LOUDNESS_TARGETS = [
  { id: 'off', label: 'As mixed', lufs: null, blurb: 'Exactly what you hear' },
  { id: 'stream', label: 'Streaming −14', lufs: -14, blurb: 'What Spotify, YouTube and others play at' },
  { id: 'loud', label: 'Loud −9', lufs: -9, blurb: 'Club and SoundCloud loud' },
  { id: 'quiet', label: 'Quiet −18', lufs: -18, blurb: 'Room to master it yourself' },
  { id: 'peak', label: 'Peak −1 dB', lufs: null, blurb: 'As loud as it goes without clipping' },
] as const;
export type LoudnessTarget = (typeof LOUDNESS_TARGETS)[number]['id'];

/** The highest sample an export is allowed to reach, as a linear gain (-1 dBFS). */
const CEILING = Math.pow(10, -1 / 20);

export interface Normalized {
  /** Gain that was applied, linear. */
  gain: number;
  /** Loudness before and after, LUFS. */
  from: number;
  to: number;
  /** The target could not be reached without clipping, so the level stops short of it. */
  limited: boolean;
}

/**
 * Scale audio in place towards a loudness target. Nothing is squashed: if reaching the target would push
 * the peaks past -1 dB, the gain stops there and `limited` says so.
 */
export function normalize(l: Float32Array, r: Float32Array, sampleRate: number, target: LoudnessTarget): Normalized {
  const from = integratedLoudness(l, r, sampleRate);
  const spec = LOUDNESS_TARGETS.find((t) => t.id === target);
  const peak = samplePeak(l, r);
  if (!spec || target === 'off' || peak === 0 || from <= SILENT) return { gain: 1, from, to: from, limited: false };
  const max = CEILING / peak;
  let gain = spec.lufs === null ? max : Math.pow(10, (spec.lufs - from) / 20);
  const limited = gain > max;
  if (limited) gain = max;
  for (let i = 0; i < l.length; i++) l[i] *= gain;
  if (r !== l) for (let i = 0; i < r.length; i++) r[i] *= gain;
  return { gain, from, to: from + 20 * Math.log10(gain), limited: limited && spec.lufs !== null };
}
