// Performance effects: things done to the whole mix with a finger on a pad
// while playing live. They are never part of a render; a filter sweep can be
// recorded, and then it becomes ordinary automation.

import { DjFilter } from './fx';

export const PERF_FX = ['Filter', 'Repeat', 'Tape stop', 'Throw'] as const;
export const PERF_HINTS = [
  'Left closes a low-pass, right opens a high-pass. Up for more resonance.',
  'Loops the last bit of the beat. Left for long slices, right for a buzz. Down makes each repeat quieter.',
  'The beat slows to a stop like a turntable being switched off. Right for a longer stop. Let go and it is back in time.',
  'Throws the mix into a long reverb. Right for more, up for a bigger room. Let go and the tail rings out.',
];
export const enum Perf { Filter, Repeat, Stop, Throw }

/** Repeat lengths in 16th-note steps, from left to right across the pad. */
export const REPEAT_DIVS = [4, 2, 1, 0.5, 0.25];
export const REPEAT_LABELS = ['1/4', '1/8', '1/16', '1/32', '1/64'];

const RING_SECONDS = 4;
const XFADE = 256;

export class PerfFx {
  fx = 0;
  on = false;
  x = 0.5;
  y = 0.5;
  private filter: DjFilter;
  // the last few seconds of the mix, which the repeat loops and the tape stop slows down
  private ringL: Float32Array;
  private ringR: Float32Array;
  private w = 0;
  private size: number;
  private mode = -1; // which effect is sounding (it can outlast `on` while it fades back)
  private loopStart = 0; private loopPos = 0; private loopGain = 1;
  private read = 0; private rate = 1;
  private wet = 0; // 0 = the live mix, 1 = the effect
  private throwAmt = 0;

  constructor(private sr: number) {
    this.filter = new DjFilter(sr);
    this.size = Math.round(sr * RING_SECONDS);
    this.ringL = new Float32Array(this.size);
    this.ringR = new Float32Array(this.size);
  }

  /** How much of the mix to feed the reverb (the throw), and how big to make the room. Call before the reverb runs. */
  throwSend(L: Float32Array, R: Float32Array, revIn: Float32Array, n: number): number {
    const target = this.on && this.fx === Perf.Throw ? 0.25 + this.x * 0.75 : 0;
    if (target === 0 && this.throwAmt < 1e-4) { this.throwAmt = 0; return 0; }
    const step = (target - this.throwAmt) / n;
    let a = this.throwAmt;
    for (let i = 0; i < n; i++) { a += step; revIn[i] += (L[i] + R[i]) * 0.5 * a; }
    this.throwAmt = target;
    return this.on ? this.y : 0;
  }

  /** Everything else, in place on the finished mix. `sps` is the length of a step in frames. */
  process(L: Float32Array, R: Float32Array, n: number, sps: number): void {
    const filtering = this.on && this.fx === Perf.Filter;
    this.filter.process(L, R, n, filtering ? this.x * 2 - 1 : 0, filtering ? this.y : 0.2);

    const { ringL, ringR, size } = this;
    const want = this.on && (this.fx === Perf.Repeat || this.fx === Perf.Stop) ? this.fx : -1;
    if (want >= 0 && this.mode !== want) {
      this.mode = want;
      this.loopPos = 0; this.loopGain = 1; this.loopStart = this.w;
      this.read = this.w; this.rate = 1;
    }
    if (this.mode < 0 && this.wet === 0) {
      // nothing engaged: just keep the ring up to date
      for (let i = 0; i < n; i++) { ringL[this.w] = L[i]; ringR[this.w] = R[i]; if (++this.w === size) this.w = 0; }
      return;
    }
    const len = Math.max(64, Math.min(size - XFADE - 1, Math.round(REPEAT_DIVS[Math.min(4, Math.floor(this.x * 5))] * sps)));
    const fall = 1 / ((0.12 + this.x * 1.6) * this.sr);
    const keep = 0.55 + 0.45 * this.y;
    for (let i = 0; i < n; i++) {
      const inL = L[i], inR = R[i];
      let fl = 0, fr = 0;
      if (this.mode === Perf.Repeat) {
        // the slice that had just played when the pad was pressed, round and round
        let at = this.loopStart - len + this.loopPos;
        if (at < 0) at += size;
        const edge = this.loopPos < 32 ? this.loopPos / 32 : len - this.loopPos < 32 ? (len - this.loopPos) / 32 : 1;
        fl = ringL[at] * this.loopGain * edge; fr = ringR[at] * this.loopGain * edge;
        if (++this.loopPos >= len) { this.loopPos = 0; this.loopGain *= keep; }
      } else {
        // tape stop: read the ring slower and slower while the mix carries on being written into it
        ringL[this.w] = inL; ringR[this.w] = inR;
        if (++this.w === size) this.w = 0;
        const ip = Math.floor(this.read), f = this.read - ip;
        const a = ip % size, b = (ip + 1) % size;
        const g = Math.min(1, this.rate * 4);
        fl = (ringL[a] + (ringL[b] - ringL[a]) * f) * g; fr = (ringR[a] + (ringR[b] - ringR[a]) * f) * g;
        this.read += this.rate;
        if (this.read >= size) this.read -= size;
        this.rate = Math.max(0, this.rate - fall);
      }
      // ease in and out of the effect so engaging and letting go never click
      this.wet += want >= 0 ? (this.wet < 1 ? 1 / XFADE : 0) : -1 / XFADE;
      if (this.wet > 1) this.wet = 1;
      if (this.wet <= 0) {
        this.wet = 0;
        if (this.mode === Perf.Repeat) this.w = this.loopStart; // carry on recording from where the loop was taken
        this.mode = -1;
        for (let k = i; k < n; k++) { ringL[this.w] = L[k]; ringR[this.w] = R[k]; if (++this.w === size) this.w = 0; }
        return;
      }
      L[i] = inL + (fl - inL) * this.wet;
      R[i] = inR + (fr - inR) * this.wet;
    }
  }
}
