// Main-thread side of the audio engine: owns the AudioContext, loads samples,
// forwards edits to the worklet and turns its step messages into something
// the UI can read once per animation frame.

import { isBuiltin, sampleUrl } from '../core/kits';
import { wavetable } from '../core/dsp/wavetable';
import type { SampleBank } from '../core/render';
import type { Project } from '../core/types';
import type { FromRecorder, FromWorklet, ToWorklet } from './worklet';
import workletUrl from './worklet.ts?worker&url';

/** How hard to push for a small output buffer. Lower latency means tighter pads; a bigger buffer is safer on a slow machine. */
export const LATENCY_MODES = ['lowest', 'balanced', 'safe'] as const;
export type LatencyMode = (typeof LATENCY_MODES)[number];
const LATENCY_HINTS: Record<LatencyMode, number | AudioContextLatencyCategory> = { lowest: 0, balanced: 'interactive', safe: 'playback' };
const LATENCY_KEY = 'loopwell:latency';

export function latencySetting(): LatencyMode {
  let saved = '';
  try { saved = localStorage.getItem(LATENCY_KEY) ?? ''; } catch { /* private mode */ }
  return (LATENCY_MODES as readonly string[]).includes(saved) ? (saved as LatencyMode) : 'balanced';
}

/** Takes effect the next time the app starts, since a browser fixes the buffer size when audio is set up. */
export function setLatencySetting(mode: LatencyMode): void {
  try { localStorage.setItem(LATENCY_KEY, mode); } catch { /* private mode */ }
}

export interface Playhead {
  /** Step of the pattern, or of the song when `song` is not -1. */
  step: number;
  pattern: number;
  /** Timeline position in steps; -1 while a single pattern loops. */
  song: number;
}

interface QueuedStep extends Playhead {
  time: number;
}

export class AudioHost {
  ctx: AudioContext | null = null;
  /** Decoded samples, kept on this side too for offline export. */
  readonly bank: SampleBank = {};
  readonly peaks = new Float32Array(8);
  masterL = 0;
  masterR = 0;
  reduction = 0;
  load = 0;
  playing = false;
  /** Called for every step as the audio thread fires it (ahead of the speakers). */
  onStepFired: ((s: Playhead, frame: number) => void) | null = null;

  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private queue: QueuedStep[] = [];
  private head: Playhead | null = null;
  private headTime = 0;
  private analyser: AnalyserNode | null = null;
  private pending = new Map<string, Promise<boolean>>();
  private backlog: ToWorklet[] = [];
  private project: Project | null = null;
  private dirty = false;
  private tables = new Set<number>();

  /** Create the context and worklet. Safe to call before any user gesture. */
  init(): Promise<void> {
    return (this.starting ??= this.start());
  }

  private async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: LATENCY_HINTS[latencySetting()] });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'loopwell', { numberOfInputs: 0, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.receive(e.data);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    node.connect(ctx.destination);
    this.analyser = analyser;
    this.ctx = ctx;
    this.node = node;
    for (const m of this.backlog) node.port.postMessage(m);
    this.backlog = [];
  }

  /** Seconds between the engine producing a sound and it leaving the speakers, as the browser reports it. */
  get latency(): number {
    const ctx = this.ctx;
    return ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Browsers only let audio start from a user gesture; call this from one. */
  async resume(): Promise<boolean> {
    await this.init();
    if (this.ctx!.state !== 'running') {
      // Without a gesture the promise from resume() never settles, so don't wait on it forever.
      const resumed = this.ctx!.resume().catch(() => {});
      await Promise.race([resumed, new Promise((r) => setTimeout(r, 300))]);
    }
    return this.running;
  }

  private send(m: ToWorklet): void {
    if (this.node) this.node.port.postMessage(m);
    else this.backlog.push(m);
  }

  private receive(m: FromWorklet): void {
    if (m.t === 'step') {
      const ctx = this.ctx!;
      this.onStepFired?.(m, m.frame);
      if (!this.playing) return;
      const latency = Math.min(0.25, ctx.outputLatency || ctx.baseLatency || 0);
      this.queue.push({ step: m.step, pattern: m.pattern, song: m.song, time: m.frame / ctx.sampleRate + latency });
      if (this.queue.length > 256) this.queue.splice(0, 128); // tab hidden: nobody is reading these
    } else {
      this.peaks.set(m.peaks);
      this.masterL = m.l;
      this.masterR = m.r;
      this.reduction = m.gr;
      this.load = m.load;
    }
  }

  /** The step that is audible right now. Call from requestAnimationFrame. */
  playhead(): Playhead | null {
    if (!this.ctx) return null;
    const t = this.ctx.currentTime;
    while (this.queue.length && this.queue[0].time <= t) {
      const next = this.queue.shift()!;
      this.head = next;
      this.headTime = next.time;
    }
    return this.playing ? this.head : null;
  }

  /**
   * The step closest to "now" as the listener hears it, for live recording.
   * `wait` is how long until that step sounds (0 if it already has).
   */
  nearest(stepSeconds: number): { step: number; pattern: number; song: number; wait: number } | null {
    const head = this.playhead();
    if (!head || !this.ctx) return null;
    const since = this.ctx.currentTime - this.headTime;
    const ahead = Math.max(0, Math.round(since / stepSeconds));
    return { step: head.step + ahead, pattern: head.pattern, song: head.song, wait: Math.max(0, ahead * stepSeconds - since) };
  }

  /** Waveform of the master output, for the scope. Returns false while nothing is connected. */
  scope(into: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteTimeDomainData(into);
    return true;
  }

  /** Send the latest project to the audio thread (coalesced to once per frame). */
  setProject(p: Project): void {
    this.project = p;
    for (const t of p.tracks) {
      if (t.kind !== 'synth') void this.ensure(t.sample);
      else {
        if (t.synth.wave >= 4) this.ensureTable(t.synth.wave - 4);
        if (t.synth.wave2 >= 4) this.ensureTable(t.synth.wave2 - 4);
      }
    }
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      if (this.project) this.send({ t: 'project', project: this.project });
    });
  }

  /** Compute a wavetable here, off the audio thread, and send it across. */
  private ensureTable(index: number): void {
    if (this.tables.has(index)) return;
    this.tables.add(index);
    setTimeout(() => this.send({ t: 'table', index, frames: wavetable(index).frames }));
  }

  /** Make sure a built-in sample is fetched, decoded and on the audio thread. */
  ensure(id: string): Promise<boolean> {
    if (this.bank[id]) return Promise.resolve(true);
    if (!isBuiltin(id)) return Promise.resolve(false);
    let p = this.pending.get(id);
    if (!p) {
      p = fetch(sampleUrl(id))
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => this.addSample(id, buf))
        .catch(() => false)
        .finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  /** Decode an audio file and register it under `id`. Resolves false if it can't be decoded. */
  async addSample(id: string, file: ArrayBuffer): Promise<boolean> {
    await this.init();
    let audio: AudioBuffer;
    try {
      audio = await this.ctx!.decodeAudioData(file.slice(0));
    } catch {
      return false;
    }
    const max = Math.min(audio.length, Math.round(audio.sampleRate * 30)); // cap very long files at 30s
    if (max < 2) return false;
    const l = audio.getChannelData(0).slice(0, max);
    const r = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice(0, max) : undefined;
    this.bank[id] = { l, r };
    this.send({ t: 'sample', id, l, r });
    return true;
  }

  // --- recording from a microphone or audio interface ---

  private rec: { stream: MediaStream; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; sink: GainNode; l: Float32Array[]; r: Float32Array[]; stereo: boolean; frames: number } | null = null;
  /** Input level of the take in progress (0..1), for a meter. */
  recLevel = 0;

  get recording(): boolean {
    return !!this.rec;
  }

  /** Seconds captured so far. */
  get recSeconds(): number {
    return this.rec ? this.rec.frames / this.sampleRate : 0;
  }

  /** Ask for an input and start capturing it. Throws if the browser or the person says no. */
  async startRecording(deviceId?: string): Promise<void> {
    if (this.rec) return;
    await this.init();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can\'t record audio.');
    // the processing browsers apply for calls ruins music, so ask for the raw input
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = this.ctx!;
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'loopwell-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // the recorder has to be part of a path to the output to be run, but it must not be heard
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);
    const rec = { stream, source, node, sink, l: [] as Float32Array[], r: [] as Float32Array[], stereo: false, frames: 0 };
    node.port.onmessage = (e: MessageEvent<FromRecorder>) => {
      rec.l.push(e.data.l);
      if (e.data.r) { rec.r.push(e.data.r); rec.stereo = true; } else rec.r.push(e.data.l);
      rec.frames += e.data.l.length;
      this.recLevel = e.data.peak;
    };
    this.rec = rec;
    this.recLevel = 0;
  }

  /** Stop capturing and return the take, or null if nothing was recorded. */
  async stopRecording(): Promise<{ l: Float32Array; r?: Float32Array; sampleRate: number } | null> {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    this.recLevel = 0;
    rec.node.port.postMessage('stop');
    await new Promise((r) => setTimeout(r, 60)); // let the last chunk arrive
    rec.source.disconnect();
    rec.node.disconnect();
    rec.sink.disconnect();
    for (const t of rec.stream.getTracks()) t.stop();
    if (!rec.frames) return null;
    const join = (parts: Float32Array[]) => {
      const out = new Float32Array(rec.frames);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    };
    return { l: join(rec.l), r: rec.stereo ? join(rec.r) : undefined, sampleRate: this.sampleRate };
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  play(pattern: number, from = 0, step = 0): void {
    this.queue = [];
    this.head = null;
    this.playing = true;
    this.send({ t: 'play', pattern, from, step });
  }

  /** Move the song position (and where the next play starts). */
  seek(step: number): void {
    this.send({ t: 'seek', step });
  }

  /** Seconds since the audible step began, for drawing a smooth playhead. */
  sinceHead(): number {
    return this.ctx && this.head ? Math.max(0, this.ctx.currentTime - this.headTime) : 0;
  }

  stop(): void {
    const wasPlaying = this.playing;
    this.playing = false;
    this.queue = [];
    this.head = null;
    this.send(wasPlaying ? { t: 'stop' } : { t: 'panic' });
  }

  setPattern(pattern: number): void {
    this.send({ t: 'pattern', pattern });
  }

  /** Hold a fill: steps marked "fill only" play until it is let go. */
  setFill(on: boolean): void {
    this.send({ t: 'fill', on });
  }

  trigger(track: number, vel: number, pitch?: number): void {
    this.send({ t: 'trig', track, vel, pitch });
  }

  noteOn(track: number, pitch: number, vel: number): void {
    this.send({ t: 'on', track, pitch, vel });
  }

  noteOff(track: number, pitch: number): void {
    this.send({ t: 'off', track, pitch });
  }
}

export const audio = new AudioHost();
