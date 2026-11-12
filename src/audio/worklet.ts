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
  | { t: 'play'; pattern: number; from: number }
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
      case 'play': e.play({ pattern: m.pattern, from: m.from }); break;
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
