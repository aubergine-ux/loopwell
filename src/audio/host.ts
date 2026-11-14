// Main-thread side of the audio engine: owns the AudioContext, loads samples,
// forwards edits to the worklet and turns its step messages into something
// the UI can read once per animation frame.

import { isBuiltin, sampleUrl } from '../core/kits';
import { wavetable } from '../core/dsp/wavetable';
import type { SampleBank } from '../core/render';
import { MAX_TRACKS, usesSample, type Project } from '../core/types';
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
  readonly busPeaks = new Float32Array(4);
  /** Reverb, then delay. */
  readonly returnPeaks = new Float32Array(2);
  /** Loudness in LUFS while metering is on: tracks, groups, reverb, delay, master (momentary), then the master's short-term and integrated. */
  loudness: Float32Array | null = null;
  /** How much the mastering chain is turning down: its three bands, then the limiter, in dB. */
  readonly mastering = new Float32Array(4);
  masterL = 0;
  masterR = 0;
  reduction = 0;
  load = 0;
  playing = false;
  /** Called for every step as the audio thread fires it (ahead of the speakers). */
  onStepFired: ((s: Playhead, frame: number) => void) | null = null;
  /** Called when the clip launcher's tracks change what they play: the pattern on each (or -2 for silent), and the step count it happened on. */
  onLaunched: ((tracks: Int8Array, count: number) => void) | null = null;
  /** Steps the engine has played since play was pressed, as of the last one it reported. */
  count = 0;
  /** Steps of count-in still to go (0 once the beat is playing). */
  countIn = 0;

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
    // if starting fails (the browser cut the audio script off, say), the next call tries again rather than failing forever
    return (this.starting ??= this.start().catch((e) => { this.starting = null; throw e; }));
  }

  private async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: LATENCY_HINTS[latencySetting()] });
    await ctx.audioWorklet.addModule(workletUrl);
    // an input for each track: where a plugin playing that track sends its sound, to go through the track's mixer strip
    const node = new AudioWorkletNode(ctx, 'loopwell', { numberOfInputs: MAX_TRACKS, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.receive(e.data);
    // worklet -> mix gain -> analyser -> speakers, with the reference track joining at the analyser,
    // so the scope and spectrum show whichever of the two is being listened to
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    const mixGain = ctx.createGain();
    const refGain = ctx.createGain();
    refGain.gain.value = 0;
    node.connect(mixGain).connect(analyser).connect(ctx.destination);
    refGain.connect(analyser);
    this.analyser = analyser;
    this.mixGain = mixGain;
    this.refGain = refGain;
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
      // Without a gesture the promise from resume() never settles, so don't wait on it forever. Right after a tap or
      // a key it will settle, but a slow device can take a second or more to get its audio going: give it that long.
      const resumed = this.ctx!.resume().catch(() => {});
      const gesture = typeof navigator !== 'undefined' && (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
      await Promise.race([resumed, new Promise((r) => setTimeout(r, gesture ? 3000 : 300))]);
    }
    return this.running;
  }

  private send(m: ToWorklet): void {
    if (this.node) this.node.port.postMessage(m);
    else this.backlog.push(m);
  }

  /** A plugin now plays `track`: `out` is the end of its chain, and `wam` how the audio thread reaches it. null takes it off. */
  plug(track: number, out: AudioNode | null, wam: { group: string; key: string; id: string } | null): void {
    if (out && this.node) out.connect(this.node, 0, track);
    this.send({ t: 'plug', track, wam });
  }

  /** Notes for plugins the audio thread couldn't hand over itself. */
  onPlugNote: ((track: number, bytes: [number, number, number], time: number) => void) | null = null;

  private receive(m: FromWorklet): void {
    if (m.t === 'plugnote') { this.onPlugNote?.(m.track, m.bytes, m.time); return; }
    if (m.t === 'step') {
      const ctx = this.ctx!;
      // a negative count is the count-in: that many steps to go before the beat starts
      if (m.count < 0) { this.countIn = -m.count; return; }
      this.countIn = 0;
      this.count = m.count;
      this.onStepFired?.(m, m.frame);
      if (!this.playing) return;
      const latency = Math.min(0.25, ctx.outputLatency || ctx.baseLatency || 0);
      this.queue.push({ step: m.step, pattern: m.pattern, song: m.song, time: m.frame / ctx.sampleRate + latency });
      if (this.queue.length > 256) this.queue.splice(0, 128); // tab hidden: nobody is reading these
    } else if (m.t === 'launched') {
      this.onLaunched?.(m.tracks, m.count);
    } else {
      this.peaks.set(m.peaks);
      this.busPeaks.set(m.buses);
      this.returnPeaks.set(m.returns);
      this.loudness = m.lufs;
      this.mastering.set(m.mastering);
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

  /** How loud each frequency is right now (0..255 per bin, bin i is i * sampleRate / 2048 Hz). Returns false while nothing is connected. */
  spectrum(into: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(into);
    return true;
  }

  // --- reference track: a finished song to compare the mix against ---

  private mixGain: GainNode | null = null;
  private refGain: GainNode | null = null;
  private refSource: AudioBufferSourceNode | null = null;
  private refBuffer: AudioBuffer | null = null;
  private refMatch = 1;
  /** True while the reference, not the mix, is what comes out of the speakers. */
  onRef = false;

  /** Decode a song to compare against. Resolves with its channels (for measuring), or null if it isn't audio. */
  async loadReference(file: ArrayBuffer): Promise<{ l: Float32Array; r: Float32Array | undefined; sampleRate: number; seconds: number } | null> {
    await this.init();
    try {
      this.clearReference();
      const buf = await this.ctx!.decodeAudioData(file.slice(0));
      if (buf.length < 2) return null;
      this.refBuffer = buf;
      return { l: buf.getChannelData(0), r: buf.numberOfChannels > 1 ? buf.getChannelData(1) : undefined, sampleRate: buf.sampleRate, seconds: buf.duration };
    } catch {
      return null;
    }
  }

  clearReference(): void {
    this.listen(false, 1);
    this.stopReference();
    this.refBuffer = null;
  }

  get hasReference(): boolean {
    return !!this.refBuffer;
  }

  /** Run the reference from `seconds` in, silently unless it is the one being listened to. It loops. */
  startReference(seconds = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.refBuffer || !this.refGain) return;
    this.stopReference();
    const src = ctx.createBufferSource();
    src.buffer = this.refBuffer;
    src.loop = true;
    src.connect(this.refGain);
    src.start(0, ((seconds % this.refBuffer.duration) + this.refBuffer.duration) % this.refBuffer.duration);
    this.refSource = src;
  }

  stopReference(): void {
    try { this.refSource?.stop(); } catch { /* it had not started */ }
    this.refSource?.disconnect();
    this.refSource = null;
  }

  /** Swap what is heard: the mix, or the reference turned up or down by `match` so the two are equally loud. */
  listen(ref: boolean, match: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.mixGain || !this.refGain) return;
    this.onRef = ref && !!this.refBuffer;
    this.refMatch = match;
    if (this.onRef && !this.refSource) this.startReference();
    const t = ctx.currentTime;
    // a short crossfade, so the switch is a comparison and not a click
    this.mixGain.gain.setTargetAtTime(this.onRef ? 0 : 1, t, 0.012);
    this.refGain.gain.setTargetAtTime(this.onRef ? match : 0, t, 0.012);
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
      if (usesSample(t.kind)) void this.ensure(t.sample);
      else if (t.kind === 'synth') {
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

  /** `countIn` steps of metronome come first; the beat starts after them. */
  play(pattern: number, from = 0, step = 0, countIn = 0): void {
    this.queue = [];
    this.head = null;
    this.playing = true;
    this.countIn = countIn;
    this.send({ t: 'play', pattern, from, step, countIn });
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
    this.countIn = 0;
    this.queue = [];
    this.head = null;
    this.send(wasPlaying ? { t: 'stop' } : { t: 'panic' });
  }

  setPattern(pattern: number): void {
    this.send({ t: 'pattern', pattern });
  }

  /** Hear the mix without the mastering chain, at the loudness it has with it. */
  setCompare(on: boolean): void {
    this.send({ t: 'compare', on });
  }

  setMetronome(on: boolean): void {
    this.send({ t: 'metronome', on });
  }

  /** Loop only steps `from`..`to` of the pattern (0, 0 = all of it). */
  setRange(from: number, to: number): void {
    this.send({ t: 'range', from, to });
  }

  /** Run the loudness meters (they cost a little CPU, so only while a mixer is on screen). */
  setMetering(on: boolean): void {
    if (!on) this.loudness = null;
    this.send({ t: 'metering', on });
  }

  /** Start the master's integrated loudness reading again. */
  resetLoudness(): void {
    this.send({ t: 'resetLoudness' });
  }

  /** Clip launcher: put a pattern (or -2 silence, -1 follow the selected pattern) on a track, on the next `quant` steps. */
  launch(track: number, pattern: number, quant: number): void {
    this.send({ t: 'launch', track, pattern, quant });
  }

  /** Performance effect: which one, whether a finger is down, and where on the pad it is (0..1 each way). */
  perf(fx: number, on: boolean, x: number, y: number): void {
    this.send({ t: 'perf', fx, on, x, y });
  }

  /** Play a sample on its own, straight to the output. Loads it first if need be; '' stops the preview. */
  async preview(id: string): Promise<boolean> {
    if (id && !(await this.ensure(id))) return false;
    this.send({ t: 'preview', id });
    return true;
  }

  /** Forget a sample that has been removed from the library. */
  dropSample(id: string): void {
    delete this.bank[id];
    this.send({ t: 'forget', id });
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
