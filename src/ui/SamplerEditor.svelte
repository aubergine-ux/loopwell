<script lang="ts">
  import { onMount } from 'svelte';
  import { assignSample, handleFiles, sampleMissing, sampleName, useKit } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { KITS, SLOTS, isBuiltin, slotLabel } from '../core/kits';
  import { isDesktop } from '../desktop';
  import { clamp } from '../core/types';
  import { addSlice, auditionSlice, autoSlice, listInputs, removeSlice, setKind, sliceEvenly, startRecording, stopRecording } from '../sound.svelte';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';
  import { byKeyboard } from './focus';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const color = $derived(`var(--t${t.color})`);
  let kit = $state(KITS[0].id);
  let picker = $state<HTMLInputElement>();
  let canvas = $state<HTMLCanvasElement>();
  let wave = $state<HTMLElement>();
  let meter = $state<HTMLElement>();
  let sensitivity = $state(64);
  let loaded = $state(0); // bumps when the sample behind the waveform arrives
  let inputs = $state<{ id: string; label: string }[]>([]);
  let input = $state('');

  const recHere = $derived(app.recording?.track === app.sel);

  // follow the selected track's kit
  $effect(() => {
    if (isBuiltin(t.sample)) kit = t.sample.split('/')[0];
  });

  function pick(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    if (el.files?.length) void handleFiles([...el.files], app.sel);
    el.value = '';
  }

  // --- waveform ---
  function draw(): void {
    const c = canvas;
    if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = audio.bank[t.sample];
    const cs = getComputedStyle(c);
    g.fillStyle = cs.getPropertyValue('--c').trim() || '#888';
    if (!data) { g.globalAlpha = 0.4; g.fillRect(0, h / 2, w, 1); return; }
    const L = data.l, n = L.length;
    for (let x = 0; x < w; x++) {
      // reversed samples are drawn the way they will be heard
      const col = t.reverse ? w - 1 - x : x;
      const a = Math.floor((col / w) * n), b = Math.max(a + 1, Math.floor(((col + 1) / w) * n));
      let lo = 0, hi = 0;
      const step = Math.max(1, Math.floor((b - a) / 64));
      for (let i = a; i < b; i += step) { const v = L[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const y0 = h / 2 - hi * (h / 2 - 1), y1 = h / 2 - lo * (h / 2 - 1);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  $effect(() => {
    const id = t.sample;
    void t.reverse; void t.color; void app.theme; void loaded; void app.userSamples[id];
    draw();
    if (!audio.bank[id]) void audio.ensure(id).then((ok) => { if (ok) loaded++; });
  });

  /** Position along the sample, 0..65535, for a pointer over the waveform. */
  function fractionAt(e: { clientX: number }): number {
    const r = wave!.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    return Math.round((t.reverse ? 1 - x : x) * 65535);
  }
  const shown = (fr: number) => (t.reverse ? 1 - fr / 65536 : fr / 65536) * 100;

  function waveDown(e: PointerEvent): void {
    if (e.button || (e.target as HTMLElement).closest('.mark')) return;
    if (t.kind !== 'slice' || !t.slices.length) { auditionSlice(app.sel, -1); return; }
    const at = fractionAt(e);
    let i = 0;
    while (i + 1 < t.slices.length && t.slices[i + 1] <= at) i++;
    t.note = i;
    auditionSlice(app.sel, i);
  }
  function waveDbl(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.mark')) return;
    if (t.kind !== 'slice') { t.slices = [0]; setKind(app.sel, 'slice'); }
    addSlice(app.sel, fractionAt(e));
  }
  let dragging = -1;
  function markDown(e: PointerEvent, i: number): void {
    if (e.button || i === 0) return;
    e.stopPropagation();
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function markMove(e: PointerEvent): void {
    if (dragging < 0) return;
    const s = t.slices, i = dragging;
    s[i] = clamp(fractionAt(e), s[i - 1] + 64, (s[i + 1] ?? 65536) - 64);
  }

  function markKey(e: KeyboardEvent, i: number): void {
    if (!byKeyboard(e.currentTarget)) return;
    const s = t.slices;
    const step = e.shiftKey ? 2048 : 256;
    if (e.key === 'Delete' || e.key === 'Backspace') removeSlice(app.sel, i);
    else if (e.key === 'Enter') auditionSlice(app.sel, i);
    else if (i > 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // on a reversed sample the picture is flipped, so the keys follow what is seen
      const d = (e.key === 'ArrowRight') !== t.reverse ? step : -step;
      s[i] = clamp(s[i] + d, s[i - 1] + 64, (s[i + 1] ?? 65536) - 64);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  async function auto(): Promise<void> {
    if (t.kind !== 'slice') { t.slices = [0]; setKind(app.sel, 'slice'); }
    await autoSlice(app.sel, sensitivity / 127);
  }
  function even(n: number): void {
    if (t.kind !== 'slice') { t.slices = [0]; setKind(app.sel, 'slice'); }
    sliceEvenly(app.sel, n);
  }

  async function rec(): Promise<void> {
    if (app.recording) { await stopRecording(); return; }
    await startRecording(app.sel, input || undefined);
    // device names only become readable once permission has been given
    inputs = await listInputs();
  }

  const stretchLabel = (v: number) => (v === 64 ? 'OFF' : `${Math.pow(2, (v - 64) / 32).toFixed(2)}x`);

  onMount(() => {
    const ro = new ResizeObserver(draw);
    if (canvas) ro.observe(canvas);
    const off = onFrame(() => {
      if (meter) meter.style.transform = `scaleX(${Math.min(1, Math.sqrt(audio.recLevel)).toFixed(3)})`;
    });
    return () => { ro.disconnect(); off(); };
  });
</script>

<div class="sampler" style:--c={color}>
  <div class="kits">
    <div class="seg">
      {#each KITS as k}
        <button class:on={kit === k.id} onclick={() => (kit = k.id)} title={k.blurb}>{k.name}</button>
      {/each}
    </div>
    <button class="btn ghost" onclick={() => useKit(kit)} title="Switch every drum track to the {kit} kit">Kit → all</button>
    <button class="btn ghost" onclick={() => (app.modal = 'samples')} title="Browse and search every sound: the kits and everything you have imported"><Icon name="grid" size={14} />Browse</button>
    <button class="btn ghost" onclick={() => picker?.click()} title="Use your own audio file. You can also drop one on a track."><Icon name="open" size={14} />Load</button>
    {#if isDesktop}<button class="btn ghost" onclick={() => (app.modal = 'folders')} title="Browse folders of samples on this computer"><Icon name="grid" size={14} />Folders</button>{/if}
    <input bind:this={picker} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.m4a" multiple hidden onchange={pick} />
    <button class="btn rec" class:on={recHere} onclick={rec} disabled={!!app.recording && !recHere} aria-pressed={recHere}
      title="Record from a microphone or audio interface onto this track">
      <i></i>{recHere ? `Stop ${app.recording!.seconds.toFixed(1)}s` : 'Record'}
    </button>
    {#if recHere}
      <span class="level" title="Input level"><i bind:this={meter}></i></span>
    {:else if inputs.length > 1}
      <select class="pick" bind:value={input} aria-label="Recording input" title="Which input to record from">
        <option value="">Default input</option>
        {#each inputs as d}<option value={d.id}>{d.label}</option>{/each}
      </select>
    {/if}
  </div>

  <div class="slots">
    {#each SLOTS as s}
      {@const id = `${kit}/${s}`}
      <button class="slot" class:on={t.sample === id} onclick={() => assignSample(app.sel, id)}>{slotLabel(id)}</button>
    {/each}
  </div>

  <div class="wave" bind:this={wave} onpointerdown={waveDown} ondblclick={waveDbl} role="application"
    aria-label="Waveform of {sampleName(t.sample)}{t.kind === 'slice' ? `, ${t.slices.length} slices` : ''}"
    title={t.kind === 'slice' ? 'Click a slice to hear it. Double-click to add a slice, drag a marker to move it.' : 'Click to hear it. Double-click to start slicing.'}>
    <canvas bind:this={canvas}></canvas>
    {#if sampleMissing(t.sample)}
      <span class="note missing">Custom sample not on this device. Drop a file here or pick a sound above.</span>
    {:else if !isBuiltin(t.sample)}
      <span class="note"><Icon name="file" size={12} />{sampleName(t.sample)}</span>
    {/if}
    {#if t.kind === 'slice'}
      {#each t.slices as s, i}
        <button class="mark" class:cur={t.note === i} class:fixed={i === 0} style:left="{shown(s)}%" aria-label="Slice {i + 1}"
          onpointerdown={(e) => markDown(e, i)} onpointermove={markMove} onpointerup={() => (dragging = -1)} onkeydown={(e) => markKey(e, i)}
          title="Drag, or use the arrow keys, to move this slice. Enter plays it, Delete removes it."
          ondblclick={(e) => { e.stopPropagation(); removeSlice(app.sel, i); }}><b>{i + 1}</b></button>
      {/each}
    {/if}
  </div>

  <div class="tools">
    <span class="label">Slice</span>
    <button class="btn" onclick={auto} title="Find the hits in the sample and slice at each one">Auto</button>
    <div class="seg">
      {#each [4, 8, 16] as n}
        <button class:on={t.kind === 'slice' && t.slices.length === n} onclick={() => even(n)} title="{n} equal slices">{n}</button>
      {/each}
    </div>
    <Knob bind:value={sensitivity} def={64} label="Sens" size={34} {color} />
    <span class="sep"></span>
    <button class="btn" class:on={t.reverse} onclick={() => (t.reverse = !t.reverse)} aria-pressed={t.reverse} title="Play the sample backwards">Reverse</button>
    <Knob bind:value={t.stretch} def={64} label="Stretch" size={34} format={stretchLabel} {color} />
  </div>
</div>

<style>
  .sampler { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
  .kits, .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .kits .btn, .tools .btn { height: 30px; padding: 0 9px; font-size: 10px; }
  .kits .pick { max-width: 160px; }
  .rec i { width: 9px; height: 9px; border-radius: 50%; background: var(--rec); }
  .rec.on { background: var(--rec); color: var(--on-c); }
  .rec.on i { background: #fff; animation: blink 1s steps(2, jump-none) infinite; }
  @keyframes blink { 50% { opacity: 0.3; } }
  .level { width: 80px; height: 8px; border-radius: 4px; background: var(--well); overflow: hidden; }
  .level i { display: block; height: 100%; background: var(--rec); transform-origin: left; transform: scaleX(0); }
  .slots { display: grid; grid-template-columns: repeat(10, 1fr); gap: 5px; }
  .slot {
    height: 28px; border-radius: 8px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 2px 0 var(--edge), inset 0 1px 0 var(--hi);
    font: 600 9.5px var(--mono); letter-spacing: 0.04em; text-transform: uppercase;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 3px;
    touch-action: manipulation;
  }
  .slot:active { transform: translateY(2px); box-shadow: none; }
  .slot.on { background: var(--c); color: var(--on-c); border-color: transparent; text-shadow: 0 1px 1px rgb(0 0 0 / 0.3); }
  .wave {
    position: relative; height: 74px; border-radius: 10px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.16);
    overflow: hidden; cursor: pointer; touch-action: manipulation;
  }
  canvas { width: 100%; height: 100%; display: block; }
  .note {
    position: absolute; right: 6px; top: 5px; display: flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 5px;
    background: color-mix(in srgb, var(--panel) 80%, transparent); font: 600 10px var(--mono); color: var(--dim); pointer-events: none;
  }
  .note.missing { color: var(--rec); left: 6px; right: 6px; white-space: normal; }
  .mark {
    position: absolute; top: 0; bottom: 0; width: 13px; margin-left: -6px; padding: 0; border: 0; background: none; cursor: ew-resize; touch-action: none;
  }
  .mark::before { content: ''; position: absolute; left: 6px; top: 0; bottom: 0; width: 1.5px; background: var(--ink); opacity: 0.75; }
  .mark.fixed { cursor: pointer; }
  .mark b {
    position: absolute; left: 7px; bottom: 2px; min-width: 14px; padding: 0 3px; border-radius: 0 4px 4px 0; background: var(--ink); color: var(--panel);
    font: 700 9px/13px var(--mono);
  }
  .mark.cur b { background: var(--c); color: var(--on-c); }
  .sep { width: 1px; height: 24px; background: var(--line); margin: 0 4px; }
  @media (max-width: 720px) { .slots { grid-template-columns: repeat(5, 1fr); } }
</style>
