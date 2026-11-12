// Main-thread side of the audio engine: owns the AudioContext, loads samples,
// forwards edits to the worklet and turns its step messages into something
// the UI can read once per animation frame.

import { isBuiltin, sampleUrl } from '../core/kits';
import type { SampleBank } from '../core/render';
import type { Project } from '../core/types';
import type { FromWorklet, ToWorklet } from './worklet';
import workletUrl from './worklet.ts?worker&url';

export interface Playhead {
  step: number;
  pattern: number;
  songPos: number;
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
  private pending = new Map<string, Promise<boolean>>();
  private backlog: ToWorklet[] = [];
  private project: Project | null = null;
  private dirty = false;

  /** Create the context and worklet. Safe to call before any user gesture. */
  init(): Promise<void> {
    return (this.starting ??= this.start());
  }

  private async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'loopwell', { numberOfInputs: 0, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.receive(e.data);
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    for (const m of this.backlog) node.port.postMessage(m);
    this.backlog = [];
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Browsers only let audio start from a user gesture; call this from one. */
  async resume(): Promise<boolean> {
    await this.init();
    if (this.ctx!.state !== 'running') {
      try { await this.ctx!.resume(); } catch { /* still locked */ }
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
      this.queue.push({ step: m.step, pattern: m.pattern, songPos: m.songPos, time: m.frame / ctx.sampleRate + latency });
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
    while (this.queue.length && this.queue[0].time <= t) this.head = this.queue.shift()!;
    return this.playing ? this.head : null;
  }

  /** Send the latest project to the audio thread (coalesced to once per frame). */
  setProject(p: Project): void {
    this.project = p;
    for (const t of p.tracks) if (t.kind === 'drum') void this.ensure(t.sample);
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      if (this.project) this.send({ t: 'project', project: this.project });
    });
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

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  play(pattern: number): void {
    this.queue = [];
    this.head = null;
    this.playing = true;
    this.send({ t: 'play', pattern });
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
