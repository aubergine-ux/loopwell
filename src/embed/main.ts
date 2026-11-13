// The embedded player: a beat from a share link, on someone else's page. It
// plays the beat with the same engine as the app, rendered once and then
// played back, and offers the way into Loopwell to remix it. Nothing here
// touches the app's own state or storage.

import { waveformPeaks } from '../core/analyze';
import { appBase, embedOptions } from '../core/embed';
import { isBuiltin, sampleUrl } from '../core/kits';
import { renderProject, type SampleBank } from '../core/render';
import { NOTE_NAMES, SCALES } from '../core/scales';
import { HASH_KEY } from '../core/share';
import { usesSample, type Project } from '../core/types';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './embed.css';

const SR = 44100;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('player'), playBtn = $<HTMLButtonElement>('play'), wave = $('wave'), canvas = $<HTMLCanvasElement>('canvas');
const titleEl = $('title'), metaEl = $('meta'), timeEl = $('time'), statusEl = $('status'), openEl = $<HTMLAnchorElement>('open');

const opts = embedOptions(location.hash);
const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { document.documentElement.dataset.theme = opts.theme || (dark.matches ? 'night' : 'cream'); draw(); };
dark.addEventListener('change', applyTheme);

type State = 'idle' | 'loading' | 'ready' | 'playing' | 'error';
let state: State = 'idle';
let rendered: { l: Float32Array; r: Float32Array } | null = null;
let rendering: Promise<boolean> | null = null;
let peaks: Float32Array | null = null;
let seconds = 0;
let ctx: AudioContext | null = null;
let buffer: AudioBuffer | null = null;
let node: AudioBufferSourceNode | null = null;
/** Where playback is, in seconds, while stopped; while playing it is worked out from the clock. */
let offset = 0, startedAt = 0;
let raf = 0;

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const now = () => (state === 'playing' && ctx ? Math.min(seconds, offset + ctx.currentTime - startedAt) : offset);

function setState(next: State, message = ''): void {
  state = next;
  root.dataset.state = next;
  playBtn.disabled = next === 'error' || (next === 'idle' && !opts.project);
  playBtn.setAttribute('aria-label', next === 'playing' ? 'Pause' : next === 'loading' ? 'Getting the beat ready' : 'Play');
  statusEl.textContent = message;
  tell();
}

/** Let the page around the player know what it is doing. */
function tell(): void {
  if (parent !== window) parent.postMessage({ loopwell: 'state', state, time: now(), duration: seconds }, '*');
}

function draw(): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(wave.clientWidth * dpr)), h = Math.max(1, Math.round(wave.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d')!;
  const cs = getComputedStyle(document.documentElement);
  const quiet = cs.getPropertyValue('--wave').trim() || '#999', loud = cs.getPropertyValue('--accent').trim() || '#f50';
  g.clearRect(0, 0, w, h);
  const bar = Math.max(2, Math.round(3 * dpr)), gap = Math.max(1, Math.round(dpr)), n = Math.floor(w / (bar + gap));
  const at = seconds ? now() / seconds : 0;
  for (let i = 0; i < n; i++) {
    let v = 0.04;
    if (peaks) {
      // the outline is kept finer than the bars, so a bar takes the loudest of what it covers
      const a = Math.floor((i / n) * (peaks.length / 2)), b = Math.max(a + 1, Math.floor(((i + 1) / n) * (peaks.length / 2)));
      for (let k = a; k < b; k++) v = Math.max(v, -peaks[k * 2], peaks[k * 2 + 1]);
    }
    const bh = Math.max(2 * dpr, Math.min(1, v) * (h - 4 * dpr));
    g.fillStyle = (i + 0.5) / n <= at && seconds ? loud : quiet;
    g.fillRect(i * (bar + gap), (h - bh) / 2, bar, bh);
  }
  timeEl.textContent = seconds ? `${clock(now())} / ${clock(seconds)}` : '0:00';
  wave.setAttribute('aria-valuenow', String(Math.round(now())));
  wave.setAttribute('aria-valuetext', `${clock(now())} of ${clock(seconds)}`);
}

function frame(): void {
  draw();
  if (state === 'playing') raf = requestAnimationFrame(frame);
}

/** What is played: the song if one is arranged, otherwise the pattern a few times round. */
function chainFor(p: Project): number[] | undefined {
  if (p.songMode) return undefined;
  const bar = (p.steps * 15) / p.bpm;
  return new Array(Math.max(1, Math.min(8, Math.round(8 / bar)))).fill(opts.pattern);
}

async function loadSamples(p: Project): Promise<SampleBank> {
  const bank: SampleBank = {};
  const ids = [...new Set(p.tracks.filter((t) => usesSample(t.kind)).map((t) => t.sample).filter(isBuiltin))];
  if (!ids.length) return bank;
  // decoding needs an audio context, but not one that is allowed to make sound yet
  const dec = new OfflineAudioContext(2, 1, SR);
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(sampleUrl(id));
      if (!res.ok) return;
      const audio = await dec.decodeAudioData(await res.arrayBuffer());
      bank[id] = { l: audio.getChannelData(0), r: audio.numberOfChannels > 1 ? audio.getChannelData(1) : undefined };
    } catch { /* a sample that can't be fetched leaves its track silent, as in the app */ }
  }));
  return bank;
}

/** Render the beat, once. Resolves false if there is nothing to hear. */
function prepare(): Promise<boolean> {
  if (rendering) return rendering;
  const p = opts.project;
  if (!p) return Promise.resolve(false);
  if (state === 'idle') setState('loading', 'Getting the beat ready…');
  rendering = (async () => {
    try {
      const bank = await loadSamples(p);
      let last = performance.now();
      const out = await renderProject(p, bank, {
        sampleRate: SR, chain: chainFor(p), maxTail: 3,
        // give the page a turn now and then, so a long song doesn't freeze the site around it
        onProgress: () => (performance.now() - last > 30 ? new Promise<void>((ok) => setTimeout(() => { last = performance.now(); ok(); })) : undefined),
      });
      if (!out.l.some((x) => x !== 0) && !out.r.some((x) => x !== 0)) {
        setState('error', 'This beat is silent.');
        return false;
      }
      rendered = out;
      seconds = out.l.length / SR;
      peaks = waveformPeaks(out.l, 600);
      wave.setAttribute('aria-valuemax', String(Math.round(seconds)));
      if (state === 'loading') setState('ready');
      draw();
      return true;
    } catch {
      setState('error', 'This beat could not be played here.');
      return false;
    }
  })();
  return rendering;
}

function stopNode(): void {
  if (!node) return;
  node.onended = null;
  try { node.stop(); } catch { /* it had not started */ }
  node.disconnect();
  node = null;
}

async function play(): Promise<void> {
  if (state === 'playing' || state === 'error') return;
  // made inside the click, which is what lets a browser start sound
  ctx ??= new AudioContext({ sampleRate: SR });
  void ctx.resume();
  if (!(await prepare()) || !rendered) return;
  if (!buffer) {
    buffer = ctx.createBuffer(2, rendered.l.length, SR);
    buffer.getChannelData(0).set(rendered.l);
    buffer.getChannelData(1).set(rendered.r);
  }
  if (offset >= seconds - 0.05) offset = 0;
  stopNode();
  node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = () => { offset = 0; node = null; cancelAnimationFrame(raf); setState('ready'); draw(); };
  startedAt = ctx.currentTime;
  node.start(0, offset);
  setState('playing');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

function pause(): void {
  if (state !== 'playing') return;
  offset = now();
  stopNode();
  cancelAnimationFrame(raf);
  setState('ready');
  draw();
}

function seek(to: number): void {
  if (!seconds) return;
  const playing = state === 'playing';
  if (playing) { stopNode(); state = 'ready'; }
  offset = Math.max(0, Math.min(seconds - 0.01, to));
  if (playing) void play();
  else { draw(); tell(); }
}

playBtn.addEventListener('click', () => (state === 'playing' ? pause() : void play()));

let dragging = false;
const seekTo = (e: PointerEvent) => { const r = wave.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * seconds); };
wave.addEventListener('pointerdown', (e) => { if (!seconds) return; dragging = true; wave.setPointerCapture(e.pointerId); seekTo(e); });
wave.addEventListener('pointermove', (e) => { if (dragging) seekTo(e); });
wave.addEventListener('pointerup', () => { dragging = false; });
wave.addEventListener('pointercancel', () => { dragging = false; });
wave.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seek(now() + step);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seek(now() - step);
  else if (e.key === 'Home') seek(0);
  else if (e.key === 'End') seek(seconds);
  else return;
  e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.target === playBtn || e.target === openEl) return;
  e.preventDefault();
  if (state === 'playing') pause(); else void play();
});

// the page around the player can drive it: { loopwell: 'play' | 'pause' | 'toggle' }
addEventListener('message', (e) => {
  const what = (e.data as { loopwell?: string } | null)?.loopwell;
  if (what === 'play') void play();
  else if (what === 'pause') pause();
  else if (what === 'toggle') { if (state === 'playing') pause(); else void play(); }
});

new ResizeObserver(draw).observe(wave);
applyTheme();

const p = opts.project;
openEl.href = `${appBase(location.href)}${opts.code && p ? `#${HASH_KEY}=${opts.code}` : ''}`;
if (!p) {
  titleEl.textContent = 'No beat here';
  setState('error', opts.code ? 'This link is not a Loopwell beat, or it was cut short.' : 'The player was given no beat to play.');
  openEl.lastChild!.textContent = ' Make one in Loopwell';
} else {
  const name = p.name && p.name !== 'untitled' ? p.name : 'A beat';
  titleEl.textContent = name;
  titleEl.title = name;
  document.title = `${name} · Loopwell`;
  const pitched = p.tracks.some((t) => t.kind === 'synth' || t.kind === 'bass');
  metaEl.textContent = `${p.bpm} bpm${pitched ? ` · ${NOTE_NAMES[p.scaleRoot]} ${SCALES[p.scaleType]?.name.toLowerCase() ?? ''}`.trimEnd() : ''}`;
  setState('idle');
  // the waveform is worked out when the player scrolls into view, so a page full of players stays light
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((en) => en.isIntersecting)) return;
    seen.disconnect();
    void prepare();
  });
  seen.observe(root);
}
