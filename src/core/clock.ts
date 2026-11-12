// Sample-domain step clock. It counts audio frames, never wall-clock time, so
// steps land on the exact sample no matter what the main thread is doing.

export function samplesPerStep(bpm: number, sampleRate: number): number {
  return (sampleRate * 60) / bpm / 4;
}

/** Off-beat 16ths are pushed late. swing 0..100 maps to 50%..75% (MPC style). */
export function swingOffset(step: number, swing: number, sps: number): number {
  return step & 1 ? (swing / 100) * 0.5 * sps : 0;
}

export class StepClock {
  bpm = 120;
  swing = 0;
  /** Index of the next step to fire, counted from the start of playback. */
  step = 0;
  /** Frames elapsed since reset. */
  pos = 0;
  /** 1 when the next step is an off-beat 16th (the ones swing delays). Flips every step; a song may set it at odd bar lengths. */
  phase = 0;
  // Un-swung grid time of the next step. Kept as a float and only rounded when
  // a step fires, so rounding error never accumulates into drift.
  private grid = 0;

  constructor(public sampleRate: number) {}

  reset(): void {
    this.step = 0;
    this.pos = 0;
    this.grid = 0;
    this.phase = 0;
  }

  /** Absolute frame at which the next step will fire. */
  nextFrame(): number {
    const sps = samplesPerStep(this.bpm, this.sampleRate);
    return Math.round(this.grid + swingOffset(this.phase, this.swing, sps));
  }

  /**
   * Advance by `frames`, calling `fire(step, offset)` for each step whose
   * start falls inside this block. `offset` is the frame within the block.
   * `fire` may change `bpm`: the new tempo sets the length of the step it was called for.
   */
  advance(frames: number, fire: (step: number, offset: number) => void): void {
    const end = this.pos + frames;
    for (;;) {
      const sps = samplesPerStep(this.bpm, this.sampleRate);
      const t = Math.round(this.grid + swingOffset(this.phase, this.swing, sps));
      if (t >= end) break;
      const n = this.step++;
      this.phase ^= 1;
      fire(n, t > this.pos ? t - this.pos : 0);
      this.grid += samplesPerStep(this.bpm, this.sampleRate);
    }
    this.pos = end;
  }
}
