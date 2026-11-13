// Getting an idea into the grid without drawing it: a hummed melody becomes
// notes, a tapped rhythm becomes a drum part, a loop is cut to the beat.

import { snapToScale } from './scales';
import { MAX_STEPS, type Note } from './types';

// --- pitch ---------------------------------------------------------------

/** A stretch of steady pitch found in a recording. Times in seconds, pitch as a (fractional) MIDI note. */
export interface HeardNote {
  start: number;
  length: number;
  pitch: number;
  /** 0..1, how loud it was next to the loudest. */
  level: number;
}

const RATE = 16000; // plenty for a voice, and far less to listen through
const WIN = 1024;
const HOP = 256;
const LOW_HZ = 70, HIGH_HZ = 1000;

function resample(x: Float32Array, from: number): Float32Array {
  const step = from / RATE;
  const n = Math.floor(x.length / step);
  const out = new Float32Array(n);
  const span = Math.max(1, Math.floor(step));
  for (let i = 0; i < n; i++) {
    // average over the samples each new one stands for, so nothing above the new rate folds back
    const at = Math.floor(i * step);
    let s = 0;
    for (let k = 0; k < span; k++) s += x[at + k] ?? 0;
    out[i] = s / span;
  }
  return out;
}

/**
 * The pitch of each moment of a recording, by the YIN method: -1 where nothing with a clear pitch is sounding.
 * Returns one value per HOP at RATE, as MIDI notes, and how loud each frame was.
 */
function track(x: Float32Array): { pitch: Float32Array; level: Float32Array } {
  const frames = Math.max(0, Math.floor((x.length - WIN * 2) / HOP));
  const pitch = new Float32Array(frames).fill(-1);
  const level = new Float32Array(frames);
  const minLag = Math.floor(RATE / HIGH_HZ), maxLag = Math.min(WIN - 1, Math.ceil(RATE / LOW_HZ));
  const d = new Float32Array(maxLag + 2);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let e = 0;
    for (let i = 0; i < WIN; i++) e += x[o + i] * x[o + i];
    level[f] = Math.sqrt(e / WIN);
    if (level[f] < 0.004) continue;
    // difference function, then normalised by its running mean so the first dip that matters stands out
    let run = 0;
    d[0] = 1;
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) { const v = x[o + i] - x[o + i + lag]; s += v * v; }
      run += s;
      d[lag] = run ? (s * lag) / run : 1;
    }
    let best = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (d[lag] < 0.15 && d[lag] <= d[lag + 1]) { best = lag; break; }
    }
    if (best < 0) continue;
    // the true dip lies between two lags
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
    pitch[f] = 69 + 12 * Math.log2(RATE / (best + shift) / 440);
  }
  return { pitch, level };
}

/** Find the notes in a recording of one voice or instrument (a hum, a whistle, a sung line). */
export function hearNotes(samples: Float32Array, sampleRate: number): HeardNote[] {
  const { pitch, level } = track(resample(samples, sampleRate));
  const n = pitch.length;
  const sec = HOP / RATE;
  const half = WIN / 2 / RATE; // a frame hears what is around its middle, so that is when it is
  let loudest = 0;
  for (let i = 0; i < n; i++) if (level[i] > loudest) loudest = level[i];
  if (!loudest) return [];
  const notes: HeardNote[] = [];
  let from = -1, sum = 0, count = 0, lv = 0, gap = 0;
  const close = (to: number) => {
    // anything shorter than 70 ms is a slide between notes or a consonant, not a note
    if (from >= 0 && (to - from) * sec >= 0.07) notes.push({ start: from * sec + half, length: (to - from) * sec, pitch: sum / count, level: lv / loudest });
    from = -1; sum = 0; count = 0; lv = 0;
  };
  for (let i = 0; i < n; i++) {
    const voiced = pitch[i] >= 0 && level[i] > loudest * 0.06;
    if (!voiced) {
      // a frame or two of nothing inside a note is a wobble; more is the end of it
      if (from >= 0 && ++gap > 3) close(i - gap + 1);
      continue;
    }
    gap = 0;
    if (from >= 0 && Math.abs(pitch[i] - sum / count) > 0.8) {
      // a new pitch: but only if it stays, so look a few frames ahead before splitting
      let stays = 0;
      for (let k = 1; k <= 4 && i + k < n; k++) if (pitch[i + k] >= 0 && Math.abs(pitch[i + k] - pitch[i]) < 0.6) stays++;
      if (stays >= 3) close(i);
      else continue;
    }
    if (from < 0) from = i;
    sum += pitch[i]; count++;
    if (level[i] > lv) lv = level[i];
  }
  close(n);
  return notes;
}

export interface NoteOptions {
  bpm: number;
  steps: number;
  /** Scale to snap to, or null to keep the semitones as sung. */
  scale: { root: number; type: number } | null;
  /** Move the whole line by octaves so it sits around this pitch. */
  around: number;
}

/**
 * Turn what was heard into notes on the grid. The first note lands on step 1 and the rest follow at the song's
 * tempo; anything past the end of the pattern is left out.
 */
export function notesFromHeard(heard: HeardNote[], o: NoteOptions): Note[] {
  if (!heard.length) return [];
  const step = 15 / o.bpm;
  const t0 = heard[0].start;
  // people don't sing in the octave a synth is set to: shift by whole octaves to where the track plays
  const mid = heard.reduce((a, h) => a + h.pitch * h.length, 0) / heard.reduce((a, h) => a + h.length, 0);
  const octave = Math.round((o.around - mid) / 12) * 12;
  const out: Note[] = [];
  for (const h of heard) {
    const s = Math.round((h.start - t0) / step);
    if (s >= o.steps) break;
    let p = Math.round(h.pitch) + octave;
    if (o.scale) p = snapToScale(p, o.scale.root, o.scale.type);
    p = Math.max(0, Math.min(127, p));
    const l = Math.max(1, Math.min(o.steps - s, Math.round(h.length / step)));
    const last = out[out.length - 1];
    if (last && last.s === s) continue; // two notes can't start on one step of a single line
    if (last && last.s + last.l > s) last.l = s - last.s;
    out.push({ s, l, p, v: Math.max(40, Math.min(127, Math.round(60 + h.level * 60))) });
  }
  return out;
}

// --- tapped rhythms --------------------------------------------------------

export interface Tapped {
  /** Velocity per step (0 = nothing). */
  steps: number[];
  bpm: number;
  /** How far off the grid the taps were on average, as a fraction of a step. */
  error: number;
}

function place(times: number[], vels: number[], bpm: number, steps: number): Tapped {
  const step = 15 / bpm;
  const out = new Array<number>(MAX_STEPS).fill(0);
  let err = 0;
  for (let i = 0; i < times.length; i++) {
    const exact = (times[i] - times[0]) / step;
    const s = Math.round(exact);
    err += Math.abs(exact - s);
    const at = ((s % steps) + steps) % steps; // a rhythm tapped for longer than the pattern wraps round onto it
    out[at] = Math.max(out[at], vels[i] ?? 100);
  }
  return { steps: out, bpm, error: err / times.length };
}

/**
 * Turn taps (times in seconds) into a row of steps. The first tap is step 1. With `bpm` the taps are read at that
 * tempo; without it, the tempo that puts them closest to the grid is worked out from the taps themselves.
 */
export function tapsToSteps(times: number[], vels: number[], steps: number, bpm?: number): Tapped | null {
  if (times.length < 2 && !bpm) return null;
  if (!times.length) return null;
  if (bpm) return place(times, vels, bpm, steps);
  let best: Tapped | null = null;
  let score = Infinity;
  for (let b = 60; b <= 180; b += 0.5) {
    const t = place(times, vels, b, steps);
    // a faster grid fits anything, so the fit has to be weighed against how many steps apart the taps come out:
    // the best reading is the slowest tempo that still lands them cleanly
    const span = (times[times.length - 1] - times[0]) / (15 / b);
    // and of two readings that fit, the one that puts the taps on beats and 8ths is what was meant, not the
    // one that makes them all off-beat 16ths
    let odd = 0, off = 0;
    for (let i = 0; i < times.length; i++) {
      const at = Math.round((times[i] - times[0]) / (15 / b));
      if (at & 1) odd++;
      if (at % 4) off++;
    }
    const cost = t.error + 0.0015 * span + (0.09 * odd + 0.03 * off) / times.length + (Math.abs(b - Math.round(b)) > 0.01 ? 0.004 : 0);
    if (cost < score) { score = cost; best = t; }
  }
  return best;
}

// --- loops -----------------------------------------------------------------

export interface LoopFit {
  /** How many beats (quarter notes) the loop is taken to be. */
  beats: number;
  /** Its tempo, from its length and that many beats. */
  bpm: number;
  /** Slice starts as fractions of the sample (0..65535), one per 8th note. */
  slices: number[];
  /** A note per slice, so the loop plays back in time at any tempo. */
  notes: Note[];
  /** Steps of pattern the loop covers (may be more than one pattern holds). */
  steps: number;
}

/**
 * Cut a loop to the beat. Given its detected tempo and length, work out how many beats it is, slice it at every
 * 8th note, and write the notes that play those slices in order: then it follows the song's tempo instead of its own.
 */
export function fitLoop(seconds: number, detectedBpm: number, patternSteps: number): LoopFit | null {
  if (!(seconds > 0.5) || !(detectedBpm > 0)) return null;
  const exact = (seconds * detectedBpm) / 60;
  // loops are cut to whole bars far more often than not
  const beats = [1, 2, 4, 8, 16, 32].reduce((a, b) => (Math.abs(Math.log2(b / exact)) < Math.abs(Math.log2(a / exact)) ? b : a));
  const pieces = Math.min(32, beats * 2);
  const slices = Array.from({ length: pieces }, (_, i) => Math.round((i / pieces) * 65536));
  const stepsEach = (beats * 4) / pieces;
  const notes: Note[] = [];
  for (let i = 0; i < pieces; i++) {
    const s = Math.round(i * stepsEach);
    if (s >= patternSteps) break;
    notes.push({ s, l: Math.max(1, Math.round(stepsEach)), p: i, v: 110 });
  }
  return { beats, bpm: Math.round(((beats * 60) / seconds) * 10) / 10, slices, notes, steps: beats * 4 };
}
