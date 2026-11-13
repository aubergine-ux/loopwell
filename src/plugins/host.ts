// The Web Audio Modules (WAM 2.0) host: loads a plugin's code, makes an
// instance of it in an audio context, and renders plugins offline for exports.
// Only loaded when a beat actually uses a plugin.

import { initializeWamHost } from '@webaudiomodules/sdk';
import { MAX_PLUGIN_STATE, type PluginRef } from '../core/types';

/** The parts of a plugin's audio node a host uses. */
export interface WamNodeLike extends AudioNode {
  instanceId?: string;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  getParameterInfo(...ids: string[]): Promise<Record<string, WamParam>>;
  getParameterValues(normalized?: boolean, ...ids: string[]): Promise<Record<string, { id: string; value: number; normalized: boolean }>>;
  setParameterValues(values: Record<string, { id: string; value: number; normalized: boolean }>): Promise<void>;
  scheduleEvents(...events: { type: 'wam-midi'; time: number; data: { bytes: [number, number, number] } }[]): void;
  destroy?(): void;
}

export interface WamParam {
  id: string; label: string; type: string; defaultValue: number; minValue: number; maxValue: number;
  discreteStep?: number; units?: string; choices?: string[];
}

export interface WamDescriptor {
  name: string; vendor: string; description?: string; isInstrument?: boolean; hasAudioInput?: boolean; hasMidiInput?: boolean;
}

export interface Wam {
  url: string;
  instance: { instanceId: string; descriptor: WamDescriptor; createGui(): Promise<HTMLElement | undefined>; destroyGui?(el: HTMLElement): void };
  node: WamNodeLike;
  descriptor: WamDescriptor;
}

export interface Host { group: string; key: string }

const hosts = new WeakMap<BaseAudioContext, Promise<Host>>();

/** Every audio context that runs plugins is set up as a host once. */
export function hostFor(ctx: BaseAudioContext): Promise<Host> {
  let h = hosts.get(ctx);
  if (!h) {
    h = initializeWamHost(ctx).then(([group, key]: [string, string]) => ({ group, key }));
    hosts.set(ctx, h);
  }
  return h;
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what} took too long`)), ms))]);

function parse(state: string): unknown {
  if (!state) return undefined;
  try { return JSON.parse(state); } catch { return undefined; }
}

/** Fetch a plugin's code and make an instance of it. Its code runs with the page's own rights: only call this for a plugin the person has agreed to. */
export async function loadWam(ctx: BaseAudioContext, url: string, state = ''): Promise<Wam> {
  const { group } = await hostFor(ctx);
  const href = new URL(url, document.baseURI).href;
  let mod: { default?: { createInstance?: (group: string, ctx: BaseAudioContext, state?: unknown) => Promise<Wam['instance'] & { audioNode: WamNodeLike }> } };
  try {
    mod = await within(import(/* @vite-ignore */ href), 30000, 'Fetching the plugin');
  } catch (e) {
    throw new Error(navigator.onLine === false ? 'You are offline, and this plugin is not on this device.' : `Its code could not be loaded (${e instanceof Error ? e.message : 'unknown error'}).`);
  }
  const make = mod.default;
  if (typeof make?.createInstance !== 'function') throw new Error('That address is not a Web Audio Module (WAM 2.0) plugin.');
  const initial = parse(state);
  const instance = await within(make.createInstance(group, ctx, initial), 30000, 'Starting the plugin');
  const node = instance?.audioNode;
  if (!node || typeof node.connect !== 'function') throw new Error('The plugin started but gave no sound output.');
  // not every plugin takes the state it is created with, so it is handed over again
  if (initial !== undefined && typeof node.setState === 'function') await within(node.setState(initial), 5000, 'Restoring its settings').catch(() => {});
  return { url, instance, node, descriptor: instance.descriptor ?? { name: 'Plugin', vendor: '' } };
}

/** A plugin's settings as text, or '' if it has none it can hand over (or far too much). */
export async function wamState(w: Wam): Promise<string> {
  if (typeof w.node.getState !== 'function') return '';
  try {
    const s = JSON.stringify(await within(w.node.getState(), 3000, 'Reading its settings')) ?? '';
    return s.length <= MAX_PLUGIN_STATE ? s : '';
  } catch {
    return '';
  }
}

export async function setWamState(w: Wam, state: string): Promise<void> {
  const s = parse(state);
  if (s === undefined || typeof w.node.setState !== 'function') return;
  await within(w.node.setState(s), 5000, 'Restoring its settings').catch(() => {});
}

export function destroyWam(w: Wam): void {
  try { w.node.disconnect(); } catch { /* not connected */ }
  try { w.node.destroy?.(); } catch { /* already gone */ }
}

/** Wire a chain in order: the instrument first, then each effect on its sound. Returns the node the sound leaves from. */
export function wire(wams: Wam[]): AudioNode {
  for (let i = 1; i < wams.length; i++) wams[i - 1].node.connect(wams[i].node);
  return wams[wams.length - 1].node;
}

export interface PlugEvent { frame: number; bytes: [number, number, number] }

/** Play `events` through a chain of plugins, faster than real time, and return what came out. */
export async function renderWams(sampleRate: number, frames: number, chain: PluginRef[], events: PlugEvent[]): Promise<{ l: Float32Array; r: Float32Array }> {
  const ctx = new OfflineAudioContext(2, Math.max(1, frames), sampleRate);
  const wams: Wam[] = [];
  try {
    for (const ref of chain) wams.push(await loadWam(ctx, ref.url, ref.state));
    wire(wams).connect(ctx.destination);
    const first = wams[0].node;
    if (typeof first.scheduleEvents === 'function') {
      for (const e of events) first.scheduleEvents({ type: 'wam-midi', time: e.frame / sampleRate, data: { bytes: e.bytes } });
      // messages are handled in order, so an answer to this one means every note above has arrived
      if (typeof first.getState === 'function') await within(first.getState(), 5000, 'Getting the plugin ready').catch(() => {});
    }
    const out = await ctx.startRendering();
    return { l: out.getChannelData(0), r: out.numberOfChannels > 1 ? out.getChannelData(1) : out.getChannelData(0) };
  } finally {
    for (const w of wams) destroyWam(w);
  }
}
