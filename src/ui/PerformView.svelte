<script lang="ts">
  import { onMount } from 'svelte';
  import { noteDown, noteUp, padDown, padUp, selectPattern } from '../actions.svelte';
  import { degreeToPitch } from '../core/scales';
  import { PATTERN_NAMES } from '../core/types';
  import { app } from '../state.svelte';
  import { onFlash } from '../visual';

  // Pads first: the whole screen is for playing. Track pads on top, a second
  // bank that plays the selected track's notes or slices, pattern switching,
  // mutes, and a touch strip for a filter sweep.
  let root: HTMLElement;
  const p = $derived(app.project);
  const cur = $derived(p.tracks[app.sel]);
  const held = new Map<number, () => void>(); // pointer id -> release

  const velocity = (e: PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.round(64 + Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * 63);
  };
  function press(e: PointerEvent, start: (vel: number) => () => void): void {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add('down');
    const stop = start(velocity(e, el));
    held.set(e.pointerId, () => { el.classList.remove('down'); stop(); });
  }
  function release(e: PointerEvent): void {
    held.get(e.pointerId)?.();
    held.delete(e.pointerId);
  }
  const trackPad = (e: PointerEvent, t: number) => press(e, (vel) => { app.sel = t; padDown(t, vel); return () => padUp(t); });

  /** The second bank: eight slices of a sliced track, or eight notes up the scale of a synth. */
  const bank = $derived.by(() => {
    if (!cur || cur.kind === 'drum' || cur.kind === 'dsyn') return [];
    if (cur.kind === 'slice') return Array.from({ length: Math.min(8, Math.max(1, cur.slices.length)) }, (_, i) => ({ label: `${i + 1}`, pitch: i }));
    return Array.from({ length: 8 }, (_, i) => {
      const pitch = p.scaleLock ? degreeToPitch(p.scaleRoot, p.scaleType, cur.note, i) : cur.note + i;
      return { label: `${i + 1}`, pitch };
    });
  });
  const notePad = (e: PointerEvent, pitch: number) => press(e, (vel) => { const t = app.sel; noteDown(t, pitch, vel); return () => noteUp(t, pitch); });

  // touch strip: sweeps the master filter while a finger is on it, and springs back when it lifts
  let sweeping = $state(false);
  let rest = 0;
  function sweep(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    if (e.type === 'pointerdown') { el.setPointerCapture(e.pointerId); rest = p.fx.filter; sweeping = true; }
    if (!sweeping) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    p.fx.filter = Math.round(x * 127 - 64);
  }
  function endSweep(): void {
    if (!sweeping) return;
    sweeping = false;
    p.fx.filter = rest;
  }

  onMount(() => onFlash((t, vel) => {
    root.querySelector(`.pad[data-pad="${t}"] .glow`)?.animate([{ opacity: 0.35 + (vel / 127) * 0.65 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
  }));
</script>

<div class="perform" bind:this={root}>
  <div class="pads">
    {#each p.tracks as t, i (i)}
      <button class="pad" class:sel={app.sel === i} class:muted={t.mute} data-pad={i} style:--c="var(--t{t.color})" aria-label="Pad {i + 1}: {t.name}"
        onpointerdown={(e) => trackPad(e, i)} onpointerup={release} onpointercancel={release} oncontextmenu={(e) => e.preventDefault()}>
        <i class="glow"></i>
        <span class="num">{i + 1}</span>
        <span class="nm">{t.name}</span>
      </button>
    {/each}
  </div>

  {#if bank.length}
    <div class="pads bank" style:--c="var(--t{cur.color})">
      {#each bank as b, i (i)}
        <button class="pad note" data-note={b.pitch} aria-label="{cur.name} {cur.kind === 'slice' ? 'slice' : 'note'} {b.label}"
          onpointerdown={(e) => notePad(e, b.pitch)} onpointerup={release} onpointercancel={release} oncontextmenu={(e) => e.preventDefault()}>
          <span class="num">{b.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="strip">
    <div class="group">
      <span class="label">Pattern</span>
      <div class="row">
        {#each PATTERN_NAMES as name, i}
          <button class="big" class:on={app.pat === i} class:queued={app.queued === i} onclick={() => selectPattern(i)} aria-pressed={app.pat === i} aria-label="Pattern {name}">{name}</button>
        {/each}
      </div>
    </div>
    <div class="group">
      <span class="label">Mute</span>
      <div class="row">
        {#each p.tracks as t, i (i)}
          <button class="big mute" class:on={t.mute} style:--c="var(--t{t.color})" onclick={() => (t.mute = !t.mute)} aria-pressed={t.mute} aria-label="Mute {t.name}">{i + 1}</button>
        {/each}
      </div>
    </div>
    <div class="group wide">
      <span class="label">Filter sweep · hold and slide</span>
      <div class="touch" class:on={sweeping} onpointerdown={sweep} onpointermove={sweep} onpointerup={endSweep} onpointercancel={endSweep}
        role="slider" tabindex="-1" aria-label="Filter sweep" aria-valuenow={p.fx.filter} aria-valuemin={-64} aria-valuemax={63}>
        <i style:left="{((p.fx.filter + 64) / 127) * 100}%"></i>
      </div>
    </div>
  </div>
</div>

<style>
  .perform { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 18px; }
  .pads { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .pad {
    position: relative; aspect-ratio: 1.5; min-height: 84px; border: 0; border-radius: 18px; padding: 10px;
    background: color-mix(in srgb, var(--c) 82%, var(--panel));
    box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 55%, #000), inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 -12px 22px -12px rgb(0 0 0 / 0.25);
    display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; color: #fff; overflow: hidden;
    touch-action: none; transition: transform 50ms, box-shadow 50ms;
  }
  .pad:global(.down) { transform: translateY(6px); box-shadow: 0 0 0 transparent, inset 0 2px 8px rgb(0 0 0 / 0.3); }
  .pad.sel { outline: 3px solid var(--ink); outline-offset: 2px; }
  .pad.muted { opacity: 0.45; }
  .pad.note { aspect-ratio: 2.4; min-height: 54px; background: color-mix(in srgb, var(--c) 45%, var(--panel)); box-shadow: 0 5px 0 color-mix(in srgb, var(--c) 40%, #000), inset 0 1px 0 rgb(255 255 255 / 0.3); }
  .glow { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, #fff 0%, rgb(255 255 255 / 0.5) 45%, transparent 80%); opacity: 0; pointer-events: none; }
  .num, .nm { position: relative; font-family: var(--mono); font-weight: 700; text-shadow: 0 1px 2px rgb(0 0 0 / 0.35); pointer-events: none; }
  .num { font-size: 12px; opacity: 0.85; }
  .nm { font-size: 13px; letter-spacing: 0.06em; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip { display: flex; flex-wrap: wrap; gap: 14px 22px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .group.wide { flex: 1 1 240px; }
  .row { display: flex; gap: 5px; flex-wrap: wrap; }
  .big {
    width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 3px 0 var(--edge), inset 0 1px 0 var(--hi); font: 700 14px var(--mono); touch-action: manipulation;
  }
  .big:active { transform: translateY(3px); box-shadow: none; }
  .big.on { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .big.queued { animation: queued 0.4s steps(2, jump-none) infinite; }
  .mute.on { background: var(--ink); color: var(--panel); }
  .mute:not(.on) { color: var(--c); }
  @keyframes queued { 50% { background: var(--accent); color: var(--accent-ink); } }
  .touch {
    position: relative; height: 44px; border-radius: 12px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.18);
    touch-action: none; cursor: ew-resize; overflow: hidden;
  }
  .touch::before { content: ''; position: absolute; left: 50%; top: 8px; bottom: 8px; width: 1px; background: var(--line); }
  .touch i { position: absolute; top: 4px; bottom: 4px; width: 14px; margin-left: -7px; border-radius: 7px; background: var(--dim); transition: left 60ms; }
  .touch.on i { background: var(--accent); transition: none; }
  @media (max-width: 720px) {
    .perform { padding: 12px; gap: 10px; }
    .pads { gap: 9px; }
    .pad { aspect-ratio: 1.15; border-radius: 14px; }
    .pad.note { aspect-ratio: 1.9; }
    .big { width: 40px; height: 40px; }
  }
  @media (max-width: 420px) {
    .pads:not(.bank) { grid-template-columns: repeat(2, 1fr); }
    .pad:not(.note) { aspect-ratio: 1.7; }
  }
</style>
