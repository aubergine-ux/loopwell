// One frame of a beat video. Everything is drawn from the audio itself and the
// times the tracks hit, so the picture moves with exactly what is heard.


export const VIDEO_SIZES = {
  vertical: { w: 1080, h: 1920, label: 'TikTok / Reels', ratio: '9:16' },
  wide: { w: 1920, h: 1080, label: 'YouTube', ratio: '16:9' },
  square: { w: 1080, h: 1080, label: 'Square post', ratio: '1:1' },
} as const;
export type VideoSize = keyof typeof VIDEO_SIZES;

export const VIDEO_STYLES = [
  { id: 'wave', label: 'Waveform' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'pads', label: 'Pads' },
  { id: 'cover', label: 'Cover art' },
] as const;
export type VideoStyle = (typeof VIDEO_STYLES)[number]['id'];

export const FPS = 30;

/** The colours of the theme the app is in, read once before a video is made. */
export interface Palette {
  bg: string;
  panel: string;
  ink: string;
  dim: string;
  accent: string;
  tracks: string[];
}

/** Something a track played, for lighting its pad. */
export interface Hit {
  /** Seconds from the start. */
  t: number;
  track: number;
  vel: number;
}

export interface Scene {
  l: Float32Array;
  r: Float32Array;
  sampleRate: number;
  seconds: number;
  hits: Hit[];
  trackNames: string[];
  trackColors: number[];
  palette: Palette;
  style: VideoStyle;
  title: string;
  tag: string;
  cover: CanvasImageSource | null;
  /** How loud the song is at each frame (0..1), and how much of that is bass: worked out once, read per frame. */
  level: Float32Array;
  bass: Float32Array;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Loudness per frame, overall and below about 150 Hz, each scaled so the loudest frame is 1. */
export function envelopes(l: Float32Array, r: Float32Array, sampleRate: number): { level: Float32Array; bass: Float32Array } {
  const per = sampleRate / FPS;
  const frames = Math.ceil(l.length / per);
  const level = new Float32Array(frames), bass = new Float32Array(frames);
  const k = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  let lp = 0, top = 1e-9, topBass = 1e-9;
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * per), b = Math.min(l.length, Math.floor((f + 1) * per));
    let s = 0, sb = 0;
    for (let i = a; i < b; i++) {
      const m = (l[i] + r[i]) * 0.5;
      lp += (m - lp) * k;
      s += m * m; sb += lp * lp;
    }
    level[f] = Math.sqrt(s / Math.max(1, b - a));
    bass[f] = Math.sqrt(sb / Math.max(1, b - a));
    if (level[f] > top) top = level[f];
    if (bass[f] > topBass) topBass = bass[f];
  }
  for (let f = 0; f < frames; f++) { level[f] /= top; bass[f] /= topBass; }
  return { level, bass };
}

// --- a small FFT for the spectrum ---
const N = 2048;
const re = new Float32Array(N), im = new Float32Array(N);
const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
function spectrum(s: Scene, t: number, bars: number, out: Float32Array): void {
  const start = Math.max(0, Math.round(t * s.sampleRate) - N / 2);
  for (let i = 0; i < N; i++) { re[i] = ((s.l[start + i] ?? 0) + (s.r[start + i] ?? 0)) * 0.5 * win[i]; im[i] = 0; }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const x = re[i]; re[i] = re[j]; re[j] = x; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const hz = s.sampleRate / N;
  for (let b = 0; b < bars; b++) {
    // bars spaced by pitch from 40 Hz to 16 kHz
    const f0 = 40 * Math.pow(400, b / bars), f1 = 40 * Math.pow(400, (b + 1) / bars);
    const a = Math.max(1, Math.floor(f0 / hz)), z = Math.min(N / 2 - 1, Math.max(a, Math.floor(f1 / hz)));
    let m = 0;
    for (let k = a; k <= z; k++) { const v = Math.hypot(re[k], im[k]); if (v > m) m = v; }
    const db = 20 * Math.log10(m / (N / 4) + 1e-9);
    out[b] = Math.max(0, Math.min(1, (db + 62) / 56));
  }
}
const bins = new Float32Array(96);

function fit(ctx: Ctx, text: string, max: number, size: number, weight: number, font: string): number {
  let px = size;
  ctx.font = `${weight} ${px}px ${font}`;
  while (px > size * 0.4 && ctx.measureText(text).width > max) { px -= 2; ctx.font = `${weight} ${px}px ${font}`; }
  return px;
}

/** Draw the frame for time `t` (seconds). */
export function drawFrame(ctx: Ctx, w: number, h: number, t: number, s: Scene): void {
  const pal = s.palette;
  const frame = Math.min(s.level.length - 1, Math.max(0, Math.floor(t * FPS)));
  const level = s.level[frame] ?? 0, bass = s.bass[frame] ?? 0;
  const unit = Math.min(w, h) / 1080; // sizes are given for a 1080-wide picture
  const sans = '"Space Grotesk Variable", system-ui, sans-serif', mono = '"JetBrains Mono Variable", ui-monospace, monospace';
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);

  // where the picture goes: a centred area with room for the words above and below it
  const pad = 70 * unit;
  const top = (s.title ? 250 : 120) * unit, bottom = h - 190 * unit;
  const ax = pad, ay = top, aw = w - pad * 2, ah = bottom - top;

  if (s.style === 'cover') {
    // the cover breathes with the bass
    const side = Math.min(aw, ah) * (0.86 + bass * 0.08);
    const cx = w / 2, cy = ay + ah / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx - side / 2, cy - side / 2, side, side, 40 * unit);
    ctx.clip();
    if (s.cover) {
      const iw = (s.cover as { width: number }).width, ih = (s.cover as { height: number }).height;
      const sc = Math.max(side / iw, side / ih);
      ctx.drawImage(s.cover, cx - (iw * sc) / 2, cy - (ih * sc) / 2, iw * sc, ih * sc);
    } else {
      // no picture chosen: one is made from the beat's own colours
      const g = ctx.createLinearGradient(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2);
      g.addColorStop(0, pal.tracks[0]); g.addColorStop(0.5, pal.tracks[6]); g.addColorStop(1, pal.tracks[4]);
      ctx.fillStyle = g;
      ctx.fillRect(cx - side / 2, cy - side / 2, side, side);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 46 * unit;
      ctx.beginPath();
      ctx.arc(cx, cy, side * 0.26, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.25 + bass * 0.6;
    ctx.lineWidth = 6 * unit;
    ctx.beginPath();
    ctx.roundRect(cx - side / 2 - 14 * unit - bass * 20 * unit, cy - side / 2 - 14 * unit - bass * 20 * unit, side + (28 + bass * 40) * unit, side + (28 + bass * 40) * unit, 52 * unit);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (s.style === 'pads') {
    const n = Math.max(1, s.trackNames.length);
    const cols = aw > ah * 1.2 ? Math.min(n, 4) : 2, rows = Math.ceil(n / cols);
    const gap = 26 * unit;
    const size = Math.min((aw - gap * (cols - 1)) / cols, (ah - gap * (rows - 1)) / rows);
    const ox = ax + (aw - (size * cols + gap * (cols - 1))) / 2, oy = ay + (ah - (size * rows + gap * (rows - 1))) / 2;
    // how brightly each pad is lit: its last hit, fading over a fifth of a second
    const glow = new Float32Array(n);
    for (let i = s.hits.length - 1; i >= 0; i--) {
      const hit = s.hits[i];
      if (hit.t > t) continue;
      if (t - hit.t > 0.25) break;
      const g = (hit.vel / 127) * Math.max(0, 1 - (t - hit.t) / 0.22);
      if (g > glow[hit.track]) glow[hit.track] = g;
    }
    for (let i = 0; i < n; i++) {
      const x = ox + (i % cols) * (size + gap), y = oy + Math.floor(i / cols) * (size + gap);
      const g = glow[i], grow = g * 10 * unit;
      ctx.fillStyle = pal.tracks[s.trackColors[i] % 8];
      ctx.globalAlpha = 0.5 + g * 0.5;
      ctx.beginPath();
      ctx.roundRect(x - grow, y - grow, size + grow * 2, size + grow * 2, 36 * unit);
      ctx.fill();
      ctx.globalAlpha = g * 0.75;
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(Math.min(34 * unit, size / 6))}px ${mono}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(s.trackNames[i].slice(0, 10), x + 24 * unit, y + size - 20 * unit);
    }
  } else if (s.style === 'spectrum') {
    const bars = aw > ah ? 96 : 56;
    spectrum(s, t, bars, bins);
    const bw = aw / bars;
    for (let b = 0; b < bars; b++) {
      const v = bins[b], bh = Math.max(6 * unit, v * ah * 0.92);
      ctx.fillStyle = pal.tracks[Math.floor((b / bars) * 8)];
      ctx.globalAlpha = 0.45 + v * 0.55;
      ctx.beginPath();
      ctx.roundRect(ax + b * bw + bw * 0.14, ay + ah - bh, bw * 0.72, bh, Math.min(bw * 0.36, 10 * unit));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    // waveform: the sound around this moment, drawn as a ribbon
    const span = Math.round(s.sampleRate * 0.045), start = Math.round(t * s.sampleRate) - span / 2;
    const cy = ay + ah / 2, amp = ah * 0.42;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [ch, color, width] of [[s.l, pal.accent, 9], [s.r, pal.ink, 4]] as const) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = ch === s.l ? 1 : 0.55;
      ctx.lineWidth = width * unit;
      ctx.beginPath();
      const points = 240;
      for (let i = 0; i <= points; i++) {
        const v = ch[start + Math.round((i / points) * span)] ?? 0;
        const x = ax + (i / points) * aw, y = cy - Math.max(-1, Math.min(1, v * 1.6)) * amp;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // words
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (s.title) {
    ctx.fillStyle = pal.ink;
    fit(ctx, s.title, w - pad * 2, 84 * unit, 700, sans);
    ctx.fillText(s.title, w / 2, 130 * unit);
  }
  if (s.tag) {
    ctx.fillStyle = pal.dim;
    fit(ctx, s.tag, w - pad * 2, 38 * unit, 600, mono);
    ctx.fillText(s.tag, w / 2, h - 118 * unit);
  }
  // how far through the song it is, and a pulse on the beat
  const done = s.seconds > 0 ? Math.min(1, t / s.seconds) : 0;
  ctx.fillStyle = pal.panel;
  ctx.beginPath();
  ctx.roundRect(pad, h - 66 * unit, w - pad * 2, 10 * unit, 5 * unit);
  ctx.fill();
  ctx.fillStyle = pal.accent;
  ctx.beginPath();
  ctx.roundRect(pad, h - 66 * unit, Math.max(10 * unit, (w - pad * 2) * done), 10 * unit, 5 * unit);
  ctx.fill();
  ctx.globalAlpha = 0.25 + level * 0.75;
  ctx.beginPath();
  ctx.arc(pad + (w - pad * 2) * done, h - 61 * unit, (9 + level * 9) * unit, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
