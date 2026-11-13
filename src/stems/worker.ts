// Stem separation, off the main thread. Runs HT-Demucs (a neural network that
// pulls a mix apart into drums, bass, vocals and everything else) with ONNX
// Runtime: on the graphics card through WebGPU where there is one, in
// WebAssembly otherwise. Nothing leaves the machine. The model is downloaded
// once and kept in the browser's cache, so after that it works offline.

import * as ort from 'onnxruntime-web/webgpu';
import { DemucsProcessor } from 'demucs-web';

import { STEMS, type FromStems, type Stem, type ToStems } from './shared';

const CACHE = 'loopwell-models';
const post = (m: FromStems, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** The model's bytes: from the cache if it has been fetched before, from the network (with progress) if not. */
async function model(url: string): Promise<ArrayBuffer> {
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`The model could not be downloaded (${res.status}).`);
  const total = +(res.headers.get('Content-Length') ?? 0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    post({ t: 'download', loaded, total });
  }
  const all = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  // kept for next time; if the browser has no room for it, it is simply fetched again
  await cache?.put(url, new Response(all, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(loaded) } })).catch(() => {});
  return all.buffer;
}

let processor: InstanceType<typeof DemucsProcessor> | null = null;
let backend = '';

async function load(url: string): Promise<void> {
  if (processor) return;
  post({ t: 'stage', stage: 'model' });
  const bytes = await model(url);
  post({ t: 'stage', stage: 'starting' });
  // threads need a cross-origin isolated page, which a plain static host can't promise: use them only when allowed
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  const gpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const make = async (providers: string[]) => {
    const p = new DemucsProcessor({
      ort,
      sessionOptions: { executionProviders: providers, graphOptimizationLevel: 'basic' },
      onProgress: (x: { progress: number; currentSegment: number; totalSegments: number }) => post({ t: 'progress', done: x.progress, segment: x.currentSegment, segments: x.totalSegments }),
    });
    await p.loadModel(bytes.slice(0));
    return p;
  };
  try {
    processor = await make(gpu ? ['webgpu', 'wasm'] : ['wasm']);
    backend = gpu ? 'WebGPU' : 'WebAssembly';
  } catch (e) {
    if (!gpu) throw e;
    // a graphics driver that can't run it is not the end: fall back to the processor
    processor = await make(['wasm']);
    backend = 'WebAssembly';
  }
}

self.onmessage = async (e: MessageEvent<ToStems>) => {
  const m = e.data;
  try {
    if (m.t === 'forget') {
      await caches.delete(CACHE);
      return;
    }
    await load(m.modelUrl);
    post({ t: 'stage', stage: 'splitting', backend });
    const began = performance.now();
    const out = await processor!.separate(m.l, m.r);
    const stems = {} as Record<Stem, { l: Float32Array; r: Float32Array }>;
    const transfer: Transferable[] = [];
    for (const s of STEMS) {
      stems[s] = { l: out[s].left, r: out[s].right };
      transfer.push(out[s].left.buffer, out[s].right.buffer);
    }
    post({ t: 'done', stems, backend, seconds: (performance.now() - began) / 1000 }, transfer);
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
