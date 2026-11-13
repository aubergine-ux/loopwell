// Plugins (Web Audio Modules): which ones a beat uses, which are running, and
// the list to pick from. A plugin is somebody else's program, so nothing is
// loaded until the person has said yes to where it comes from. The host
// itself (src/plugins/host.ts) is only fetched once a beat needs it.

import { untrack } from 'svelte';
import { audio } from './audio/host';
import { renderProject, type RenderOptions, type SampleBank } from './core/render';
import { MAX_PLUGINS, MAX_TRACKS, pluginUrlOk, type PluginRef, type Project } from './core/types';
import type { PlugEvent, Wam } from './plugins/host';
import { app } from './state.svelte';
import { loadText, saveText } from './storage';

export interface PluginEntry {
  url: string;
  name: string;
  vendor: string;
  description: string;
  instrument: boolean;
  thumbnail?: string;
}

/** The plugins that come with Loopwell. Their source is in public/plugins, as an example to build from. */
export const BUILTIN_PLUGINS: PluginEntry[] = [
  { url: 'plugins/pluck/index.js', name: 'Pluck', vendor: 'Loopwell', instrument: true, description: 'A plucked string: harps, guitars, kotos and basses.' },
  { url: 'plugins/wobble/index.js', name: 'Wobble', vendor: 'Loopwell', instrument: false, description: 'A slow, wide chorus.' },
];

/** The list the Web Audio Modules community keeps of plugins anyone can load. */
const COMMUNITY_LIST = 'https://www.webaudiomodules.com/community/plugins.json';
const COMMUNITY_BASE = 'https://www.webaudiomodules.com/community/plugins/';

export type SlotStatus = 'ask' | 'loading' | 'ready' | 'error';
export interface Slot { url: string; name: string; status: SlotStatus; error: string; vendor: string; instrument: boolean }

export const plug = $state({
  /** What is on each track, for the screen. */
  tracks: [] as Slot[][],
  /** The plugin whose own window is open. */
  open: null as { track: number; index: number } | null,
  /** What the browser is choosing for: a slot on a track (`index` past the end adds an effect). */
  pick: null as { track: number; index: number } | null,
  community: [] as PluginEntry[],
  communityState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
});

// --- trust ---------------------------------------------------------------

const TRUST = 'loopwell:plugins-trusted';
const trustedSet = new Set<string>((() => { try { return JSON.parse(loadText(TRUST) ?? '[]') as string[]; } catch { return []; } })());

/** The ones in the app's own folder are part of the app. */
export const isBuiltinPlugin = (url: string) => url.startsWith('plugins/');
export const isTrusted = (url: string) => isBuiltinPlugin(url) || trustedSet.has(url);

export function trustPlugin(url: string): void {
  if (isBuiltinPlugin(url) || trustedSet.has(url)) return;
  trustedSet.add(url);
  saveText(TRUST, JSON.stringify([...trustedSet].slice(-200)));
}

/** Where a plugin comes from, for showing to the person who has to decide. */
export function pluginHost(url: string): string {
  if (isBuiltinPlugin(url)) return 'Loopwell';
  try { return new URL(url).host; } catch { return url; }
}

// --- the running plugins -------------------------------------------------

interface Chain { sig: string; wams: Wam[]; states: string[]; gen: number }
const live: (Chain | null)[] = [];
let gen = 0;

const sigOf = (list: PluginRef[]) => list.map((x) => x.url).join('\n');
const wanted = (p: Project, t: number): PluginRef[] => (p.tracks[t]?.kind === 'plugin' ? p.tracks[t].plugins : []);

function teardown(t: number): void {
  const c = live[t];
  live[t] = null;
  if (!c) return;
  audio.plug(t, null, null);
  if (c.wams.length) void import('./plugins/host').then((h) => c.wams.forEach(h.destroyWam));
}

async function build(t: number, list: PluginRef[], mine: number): Promise<void> {
  const slots = plug.tracks[t];
  const made: Wam[] = [];
  const h = await import('./plugins/host');
  try {
    await audio.init();
    const ctx = audio.ctx!;
    const host = await h.hostFor(ctx);
    for (let i = 0; i < list.length; i++) {
      try {
        const w = await h.loadWam(ctx, list[i].url, list[i].state);
        made.push(w);
        if (live[t]?.gen !== mine) throw new Error('changed');
        const s = slots[i];
        if (s) { s.status = 'ready'; s.vendor = w.descriptor.vendor ?? ''; s.instrument = !!w.descriptor.isInstrument; if (w.descriptor.name && s.name === 'Plugin') s.name = w.descriptor.name; }
      } catch (e) {
        if (live[t]?.gen === mine && slots[i]) { slots[i].status = 'error'; slots[i].error = e instanceof Error ? e.message : 'It would not start.'; }
        throw e;
      }
    }
    const c = live[t];
    if (!c || c.gen !== mine) throw new Error('changed');
    c.wams = made;
    audio.plug(t, h.wire(made), { group: host.group, key: host.key, id: made[0].instance.instanceId });
  } catch {
    made.forEach(h.destroyWam);
    // whatever came after the one that failed never got its turn
    if (live[t]?.gen === mine) for (const s of slots) if (s.status === 'loading') { s.status = 'error'; s.error = 'Not started, because the plugin before it failed.'; }
  }
}

/** Make what is running match the beat. Called whenever the beat changes; does nothing when no track uses a plugin. */
export function syncPlugins(p: Project): void {
  untrack(() => syncNow(p));
}

function syncNow(p: Project): void {
  for (let t = 0; t < MAX_TRACKS; t++) {
    const list = wanted(p, t);
    const sig = sigOf(list);
    const cur = live[t];
    if (!cur && !list.length) { if (plug.tracks[t]?.length) plug.tracks[t] = []; continue; }
    if (cur && cur.sig === sig) {
      // the same plugins: an undo, or someone in a live session, may have changed their settings
      list.forEach((x, i) => {
        if (x.state === cur.states[i] || !cur.wams[i]) return;
        cur.states[i] = x.state;
        void import('./plugins/host').then((h) => h.setWamState(cur.wams[i], x.state));
      });
      continue;
    }
    teardown(t);
    if (plug.open?.track === t) plug.open = null;
    if (!list.length) { plug.tracks[t] = []; continue; }
    const ok = list.every((x) => isTrusted(x.url));
    plug.tracks[t] = list.map((x) => ({ url: x.url, name: x.name, status: ok ? 'loading' : 'ask', error: '', vendor: '', instrument: false }));
    const mine = ++gen;
    // remembered even while waiting for a yes, so the question is put once and not on every edit
    live[t] = { sig, wams: [], states: list.map((x) => x.state), gen: mine };
    if (!ok) continue;
    void build(t, list.map((x) => ({ ...x })), mine);
  }
}

audio.onPlugNote = (track, bytes, time) => {
  live[track]?.wams[0]?.node.scheduleEvents?.({ type: 'wam-midi', time, data: { bytes } });
};

/** Say yes to everything a track wants to load, and load it. */
export function allowTrack(t: number): void {
  for (const x of wanted(app.project, t)) trustPlugin(x.url);
  teardown(t);
  syncPlugins(app.project);
}

export function retryTrack(t: number): void {
  teardown(t);
  syncPlugins(app.project);
}

/** Copy the plugins' current settings into the beat, so they are saved, shared and undone with it. */
export async function capturePlugins(t: number): Promise<void> {
  const c = live[t];
  if (!c?.wams.length) return;
  const h = await import('./plugins/host');
  for (let i = 0; i < c.wams.length; i++) {
    const s = await h.wamState(c.wams[i]);
    const ref = app.project.tracks[t]?.plugins[i];
    if (live[t] !== c || !ref || s === c.states[i]) continue;
    c.states[i] = s;
    ref.state = s;
  }
}

export const runningPlugin = (t: number, i: number): Wam | null => live[t]?.wams[i] ?? null;

// --- choosing ------------------------------------------------------------

/** Put a plugin on a track: at `index`, or after the others as an effect when `index` is past the end. */
export function setPlugin(t: number, index: number, entry: { url: string; name: string }): boolean {
  const tr = app.project.tracks[t];
  if (!tr || !pluginUrlOk(entry.url) || index >= MAX_PLUGINS) return false;
  // picking it from the browser is the person's yes
  trustPlugin(entry.url);
  const ref: PluginRef = { url: entry.url, name: entry.name.slice(0, 40) || 'Plugin', state: '' };
  if (index < tr.plugins.length) tr.plugins[index] = ref;
  else tr.plugins.push(ref);
  return true;
}

export function removePlugin(t: number, index: number): void {
  app.project.tracks[t]?.plugins.splice(index, 1);
}

export async function loadCommunity(): Promise<void> {
  if (plug.communityState === 'loading' || plug.communityState === 'ready') return;
  plug.communityState = 'loading';
  try {
    const res = await fetch(COMMUNITY_LIST);
    if (!res.ok) throw new Error(String(res.status));
    const list = (await res.json()) as { name?: string; vendor?: string; description?: string; category?: string[]; keywords?: string[]; path?: string; thumbnail?: string }[];
    plug.community = list.flatMap((x) => {
      const url = typeof x.path === 'string' ? COMMUNITY_BASE + x.path : '';
      if (!pluginUrlOk(url) || typeof x.name !== 'string') return [];
      const tags = [...(x.category ?? []), ...(x.keywords ?? [])].join(' ').toLowerCase();
      return [{
        url, name: x.name.slice(0, 40), vendor: String(x.vendor ?? '').slice(0, 40), description: String(x.description ?? '').slice(0, 200),
        instrument: /instrument|synth|sampler|piano|drum machine/.test(tags) && !/\beffect\b/.test(tags),
        thumbnail: typeof x.thumbnail === 'string' && pluginUrlOk(COMMUNITY_BASE + x.thumbnail) ? COMMUNITY_BASE + x.thumbnail : undefined,
      }];
    });
    plug.communityState = 'ready';
  } catch {
    plug.communityState = 'error';
  }
}

// --- exports -------------------------------------------------------------

/**
 * What the plugins play in a render, ready to hand to renderProject as `ext`. The beat is run through once to
 * hear which notes the plugins are sent, then each plugin track is played offline. Nothing is returned (and
 * nothing loaded) when no track uses a plugin; one the person hasn't agreed to is left silent.
 */
export async function pluginAudio(p: Project, bank: SampleBank, opts: { sampleRate: number; chain?: number[] }): Promise<RenderOptions['ext']> {
  const tracks: number[] = [];
  p.tracks.forEach((t, i) => { if (t.kind === 'plugin' && t.plugins.length && t.plugins.every((x) => isTrusted(x.url))) tracks.push(i); });
  if (!tracks.length) return undefined;
  const events = new Map<number, PlugEvent[]>(tracks.map((t) => [t, []]));
  const dry = await renderProject(p, bank, {
    sampleRate: opts.sampleRate, chain: opts.chain,
    onPlug: (track, on, pitch, vel, frame) => {
      const list = events.get(track);
      if (!list) return;
      if (pitch < 0) list.push({ frame, bytes: [0xb0, 123, 0] });
      else list.push({ frame, bytes: [on ? 0x90 : 0x80, pitch & 127, on ? Math.max(1, Math.min(127, vel)) : 0] });
    },
  });
  const h = await import('./plugins/host');
  const ext: NonNullable<RenderOptions['ext']> = {};
  // long enough for what the engine made plus the plugins' own tails
  const frames = dry.l.length + Math.round(opts.sampleRate * 6);
  for (const t of tracks) {
    const list = events.get(t)!;
    if (!list.length) continue;
    try {
      ext[t] = await h.renderWams(opts.sampleRate, frames, p.tracks[t].plugins, list);
    } catch { /* a plugin that won't start leaves its track silent, as it is when playing */ }
  }
  return ext;
}

export const usesPlugins = (p: Project) => p.tracks.some((t) => t.kind === 'plugin' && t.plugins.length > 0);
