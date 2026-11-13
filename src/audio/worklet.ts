// AudioWorklet wrapper around the Engine. All sequencing happens here, on the
// audio thread, counted in frames. The main thread only sends edits and
// receives step/meter notifications for the lights.

import { Engine, METER_CHANNELS } from '../core/engine';
import { MAX_TRACKS, type Project } from '../core/types';

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
  | { t: 'play'; pattern: number; from: number; step: number; countIn: number }
  | { t: 'metronome'; on: boolean }
  | { t: 'range'; from: number; to: number }
  | { t: 'seek'; step: number }
  | { t: 'stop' }
  | { t: 'panic' }
  | { t: 'pattern'; pattern: number }
  | { t: 'fill'; on: boolean }
  | { t: 'preview'; id: string }
  | { t: 'launch'; track: number; pattern: number; quant: number }
  | { t: 'perf'; fx: number; on: boolean; x: number; y: number }
  | { t: 'forget'; id: string }
  | { t: 'metering'; on: boolean }
  | { t: 'compare'; on: boolean }
  | { t: 'resetLoudness' }
  | { t: 'trig'; track: number; vel: number; pitch?: number }
  | { t: 'on'; track: number; pitch: number; vel: number }
  | { t: 'off'; track: number; pitch: number }
  /** Which plugin plays a track (null: none). The three strings are how the audio thread finds it. */
  | { t: 'plug'; track: number; wam: { group: string; key: string; id: string } | null };

export type FromWorklet =
  | { t: 'step'; step: number; pattern: number; song: number; frame: number; count: number }
  | { t: 'launched'; tracks: Int8Array; count: number }
  /** A MIDI message for a plugin that can't be reached on the audio thread, for the main thread to pass on. */
  | { t: 'plugnote'; track: number; bytes: [number, number, number]; time: number }
  | { t: 'meter'; peaks: Float32Array; buses: Float32Array; returns: Float32Array; l: number; r: number; gr: number; load: number; lufs: Float32Array | null; mastering: Float32Array };

const METER_BLOCKS = 6;
const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

class LoopwellProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  private scratch = new Float32Array(128);
  private blocks = 0;
  private busy = 0;
  private idle = true;
  private lufs = new Float32Array(METER_CHANNELS + 2);
  // plugins: who plays each track, where their sound arrives, and which of their notes are down
  private wams: ({ group: string; key: string; id: string } | null)[] = [];
  private ins = Array.from({ length: MAX_TRACKS }, (): { l: Float32Array; r: Float32Array } => ({ l: this.scratch, r: this.scratch }));
  private down = Array.from({ length: MAX_TRACKS }, () => new Uint8Array(128));

  constructor() {
    super();
    this.engine.buildTables = false; // computed on the main thread and sent over, so audio never waits for one
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.handle(e.data);
    this.engine.onStep = (i) =>
      this.post({ t: 'step', step: i.step, pattern: i.pattern, song: i.song, frame: currentFrame + i.offset, count: i.count });
    this.engine.onLaunch = (tracks, count) => this.post({ t: 'launched', tracks: tracks.slice(), count });
    this.engine.onPlug = (track, on, pitch, vel, offset) => this.plug(track, on, pitch, vel, offset);
  }

  private post(m: FromWorklet): void {
    this.port.postMessage(m);
  }

  /** Pass a note to the plugin on a track, as MIDI. */
  private plug(track: number, on: boolean, pitch: number, vel: number, offset: number): void {
    const w = this.wams[track];
    if (!w) return;
    // The plugin has already made this block (its sound is what is on our input), so the note is placed at the
    // same spot in the next one: plugin tracks sound one block (3 ms) late, always by exactly that.
    const time = (currentFrame + offset + 128) / sampleRate;
    // every plugin made with the standard kit registers itself on the audio thread, where it can be handed the note
    // on its exact frame; one that doesn't gets it through the main thread, a little less exactly
    let proc: { scheduleEvents(...e: unknown[]): void } | undefined;
    try {
      proc = (globalThis as unknown as { webAudioModules?: { getGroup(g: string, k: string): { processors: Map<string, typeof proc> } } })
        .webAudioModules?.getGroup(w.group, w.key).processors.get(w.id);
    } catch { /* no such group: the main thread it is */ }
    const send = (a: number, b: number, c: number) => {
      if (proc) proc.scheduleEvents({ type: 'wam-midi', time, data: { bytes: [a, b, c] } });
      else this.post({ t: 'plugnote', track, bytes: [a, b, c], time });
    };
    const down = this.down[track];
    if (pitch < 0) {
      // "all notes off" is something not every plugin listens to, so each note that is down is ended by name too
      for (let p = 0; p < 128; p++) if (down[p]) { send(0x80, p, 0); down[p] = 0; }
      send(0xb0, 123, 0);
    } else if (on) { down[pitch & 127] = 1; send(0x90, pitch & 127, Math.max(1, Math.min(127, vel))); }
    else { down[pitch & 127] = 0; send(0x80, pitch & 127, 0); }
  }

  private handle(m: ToWorklet): void {
    const e = this.engine;
    switch (m.t) {
      case 'project': e.setProject(m.project); break;
      case 'sample': e.setSample(m.id, m.l, m.r); break;
      case 'table': e.setTable(m.index, m.frames); break;
      case 'play': e.play({ pattern: m.pattern, from: m.from, step: m.step, countIn: m.countIn }); break;
      case 'metronome': e.metronome = m.on; break;
      case 'range': e.setRange(m.from, m.to); break;
      case 'seek': e.seek(m.step); break;
      case 'stop': e.stop(); break;
      case 'panic': e.stop(); e.panic(); break;
      case 'pattern': e.setPattern(m.pattern); break;
      case 'fill': e.fill = m.on; break;
      case 'preview': e.preview(m.id); break;
      case 'launch': e.launchClip(m.track, m.pattern, m.quant); break;
      case 'perf': e.perf.fx = m.fx; e.perf.on = m.on; e.perf.x = m.x; e.perf.y = m.y; break;
      case 'forget': e.dropSample(m.id); break;
      case 'metering': e.setMetering(m.on); break;
      case 'compare': e.compare = m.on; break;
      case 'resetLoudness': e.resetLoudness(); break;
      case 'trig': e.trigger(m.track, m.vel, m.pitch); break;
      case 'on': e.noteOn(m.track, m.pitch, m.vel); break;
      case 'off': e.noteOff(m.track, m.pitch); break;
      case 'plug':
        // whatever the old plugin was holding ends with it
        if (this.wams[m.track]) this.plug(m.track, false, -1, 0, 0);
        this.wams[m.track] = m.wam;
        break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    if (!l) return true;
    const n = l.length;
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    const t0 = now();
    const e = this.engine;
    // what the plugins played: each one is wired to the input with its track's number
    for (let t = 0; t < MAX_TRACKS; t++) {
      const a = inputs[t]?.[0];
      if (a && this.wams[t]) { const io = this.ins[t]; io.l = a; io.r = inputs[t][1] ?? a; e.ext[t] = io; }
      else e.ext[t] = undefined;
    }
    e.process(l, out[1] ?? this.scratch, n);
    this.busy += now() - t0;
    if (++this.blocks >= METER_BLOCKS) {
      const silent = e.masterPeakL + e.masterPeakR < 1e-5;
      // keep quiet while nothing is happening, but always send the frame that zeroes the meters
      if (!silent || !this.idle) {
        const load = this.busy / (((this.blocks * n) / sampleRate) * 1000);
        const lufs = e.readLoudness(this.lufs) ? this.lufs.slice() : null;
        this.post({ t: 'meter', peaks: e.peaks.slice(), buses: e.busPeaks.slice(), returns: e.retPeaks.slice(), l: e.masterPeakL, r: e.masterPeakR, gr: e.compReduction, load, lufs, mastering: e.mastering.reduction.slice() });
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
