// AudioWorklet wrapper around the Engine. All sequencing happens here, on the
// audio thread, counted in frames. The main thread only sends edits and
// receives step/meter notifications for the lights.

import { Engine } from '../core/engine';
import type { Project } from '../core/types';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type ToWorklet =
  | { t: 'project'; project: Project }
  | { t: 'sample'; id: string; l: Float32Array; r?: Float32Array }
  | { t: 'table'; index: number; frames: Float32Array[][] }
  | { t: 'play'; pattern: number; from: number; step: number }
  | { t: 'seek'; step: number }
  | { t: 'stop' }
  | { t: 'panic' }
  | { t: 'pattern'; pattern: number }
  | { t: 'trig'; track: number; vel: number; pitch?: number }
  | { t: 'on'; track: number; pitch: number; vel: number }
  | { t: 'off'; track: number; pitch: number };

export type FromWorklet =
  | { t: 'step'; step: number; pattern: number; song: number; frame: number }
  | { t: 'meter'; peaks: Float32Array; l: number; r: number; gr: number; load: number };

const METER_BLOCKS = 6;
const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

class LoopwellProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  private scratch = new Float32Array(128);
  private blocks = 0;
  private busy = 0;
  private idle = true;

  constructor() {
    super();
    this.engine.buildTables = false; // computed on the main thread and sent over, so audio never waits for one
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.handle(e.data);
    this.engine.onStep = (i) =>
      this.post({ t: 'step', step: i.step, pattern: i.pattern, song: i.song, frame: currentFrame + i.offset });
  }

  private post(m: FromWorklet): void {
    this.port.postMessage(m);
  }

  private handle(m: ToWorklet): void {
    const e = this.engine;
    switch (m.t) {
      case 'project': e.setProject(m.project); break;
      case 'sample': e.setSample(m.id, m.l, m.r); break;
      case 'table': e.setTable(m.index, m.frames); break;
      case 'play': e.play({ pattern: m.pattern, from: m.from, step: m.step }); break;
      case 'seek': e.seek(m.step); break;
      case 'stop': e.stop(); break;
      case 'panic': e.stop(); e.panic(); break;
      case 'pattern': e.setPattern(m.pattern); break;
      case 'trig': e.trigger(m.track, m.vel, m.pitch); break;
      case 'on': e.noteOn(m.track, m.pitch, m.vel); break;
      case 'off': e.noteOff(m.track, m.pitch); break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    if (!l) return true;
    const n = l.length;
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    const t0 = now();
    const e = this.engine;
    e.process(l, out[1] ?? this.scratch, n);
    this.busy += now() - t0;
    if (++this.blocks >= METER_BLOCKS) {
      const silent = e.masterPeakL + e.masterPeakR < 1e-5;
      // keep quiet while nothing is happening, but always send the frame that zeroes the meters
      if (!silent || !this.idle) {
        const load = this.busy / (((this.blocks * n) / sampleRate) * 1000);
        this.post({ t: 'meter', peaks: e.peaks.slice(), l: e.masterPeakL, r: e.masterPeakR, gr: e.compReduction, load });
      }
      this.idle = silent;
      e.resetMeters();
      this.blocks = 0;
      this.busy = 0;
    }
    return true;
  }
}

registerProcessor('loopwell', LoopwellProcessor);

export type FromRecorder = { l: Float32Array; r: Float32Array | null; peak: number };
const REC_CHUNK = 4096;

/** Captures whatever is plugged into its input (a microphone or an interface) and hands it to the main thread in chunks. */
class RecorderProcessor extends AudioWorkletProcessor {
  private l = new Float32Array(REC_CHUNK);
  private r = new Float32Array(REC_CHUNK);
  private n = 0;
  private peak = 0;
  private stereo = false;
  private on = true;

  constructor() {
    super();
    this.port.onmessage = () => { this.flush(); this.on = false; };
  }

  private flush(): void {
    if (!this.n) return;
    const m: FromRecorder = { l: this.l.slice(0, this.n), r: this.stereo ? this.r.slice(0, this.n) : null, peak: this.peak };
    this.port.postMessage(m, m.r ? [m.l.buffer, m.r.buffer] : [m.l.buffer]);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const a = input?.[0];
    if (!this.on) return false;
    if (!a) return true;
    const b = input[1];
    if (b) this.stereo = true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      this.l[this.n] = x;
      this.r[this.n] = b ? b[i] : x;
      const v = x < 0 ? -x : x;
      if (v > this.peak) this.peak = v;
      if (++this.n === REC_CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('loopwell-rec', RecorderProcessor);
