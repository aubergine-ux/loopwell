<script lang="ts">
  import { onMount } from 'svelte';
  import { noteDown, noteUp, padDown, padUp } from '../actions.svelte';
  import { app } from '../state.svelte';
  import { fade, onFlash } from '../visual';

  let root: HTMLElement;
  const p = $derived(app.project);
  const cur = $derived(p.tracks[app.sel]);
  // with a sliced track selected, the pads play its slices; "Tracks" flips back
  let tracksOnly = $state(false);
  $effect(() => { void app.sel; tracksOnly = false; });
  const slices = $derived(cur?.kind === 'slice' && !tracksOnly ? Math.min(16, Math.max(1, cur.slices.length)) : 0);

  function sliceDown(e: PointerEvent, i: number): void {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const vel = Math.round(70 + Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * 57);
    el.classList.add('down');
    cur.note = i;
    noteDown(app.sel, i, vel);
  }
  function sliceUp(e: PointerEvent, i: number): void {
    (e.currentTarget as HTMLElement).classList.remove('down');
    noteUp(app.sel, i);
  }
  const downBy = new Map<number, number>(); // pointer id -> track

  function down(e: PointerEvent, t: number): void {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // hit near the top for loud, near the bottom for soft
    const r = el.getBoundingClientRect();
    const y = 1 - (e.clientY - r.top) / r.height;
    const vel = Math.round(70 + Math.min(1, Math.max(0, y)) * 57);
    app.sel = t;
    downBy.set(e.pointerId, t);
    el.classList.add('down');
    padDown(t, vel);
  }
  function up(e: PointerEvent): void {
    const t = downBy.get(e.pointerId);
    if (t === undefined) return;
    downBy.delete(e.pointerId);
    (e.currentTarget as HTMLElement).classList.remove('down');
    padUp(t);
  }

  // from the keyboard: Enter plays a pad for as long as it is held
  function key(e: KeyboardEvent, t: number, on: boolean): void {
    if (e.key !== 'Enter' || e.repeat) return;
    e.preventDefault();
    if (on) { app.sel = t; padDown(t, 110); } else padUp(t);
  }
  function sliceKey(e: KeyboardEvent, i: number, on: boolean): void {
    if (e.key !== 'Enter' || e.repeat) return;
    e.preventDefault();
    if (on) { cur.note = i; noteDown(app.sel, i, 110); } else noteUp(app.sel, i);
  }

  onMount(() => onFlash((t, vel) => {
    const glow = root.querySelector(`.pad[data-pad="${t}"] .glow`);
    if (glow) fade(glow, 0.35 + (vel / 127) * 0.65);
  }));
</script>

<div class="pads" class:slices={slices > 0} bind:this={root}>
  {#if slices}
    {#each { length: slices } as _, i}
      <button class="pad" class:sel={cur.note === i} data-slice={i} style:--c="var(--t{cur.color})" aria-label="Slice {i + 1} of {cur.name}"
        onpointerdown={(e) => sliceDown(e, i)} onpointerup={(e) => sliceUp(e, i)} onpointercancel={(e) => sliceUp(e, i)} oncontextmenu={(e) => e.preventDefault()}
        onkeydown={(e) => sliceKey(e, i, true)} onkeyup={(e) => sliceKey(e, i, false)}>
        <span class="num">{i + 1}</span>
      </button>
    {/each}
    <button class="btn ghost back" onclick={() => (tracksOnly = true)}>Tracks</button>
  {:else}
    {#each { length: 8 } as _, i}
      {@const t = p.tracks[i]}
      {#if t}
        <button class="pad" class:sel={app.sel === i} data-pad={i} style:--c="var(--t{t.color})" aria-label="Pad {i + 1}: {t.name}"
          onpointerdown={(e) => down(e, i)} onpointerup={up} onpointercancel={up} oncontextmenu={(e) => e.preventDefault()}
          onkeydown={(e) => key(e, i, true)} onkeyup={(e) => key(e, i, false)}>
          <i class="glow"></i>
          <span class="num">{i + 1}</span>
          <span class="nm">{t.name}</span>
        </button>
      {:else}
        <div class="pad empty"></div>
      {/if}
    {/each}
    {#if cur?.kind === 'slice'}<button class="btn ghost back" onclick={() => (tracksOnly = false)}>Slices</button>{/if}
  {/if}
</div>

<style>
  .pads { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; align-content: start; }
  .pad {
    position: relative; aspect-ratio: 1.32; min-height: 58px;
    border: 0; border-radius: 14px; padding: 8px;
    background: color-mix(in srgb, var(--c) 82%, var(--panel));
    box-shadow: 0 5px 0 color-mix(in srgb, var(--c) 55%, #000), inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 -10px 18px -10px rgb(0 0 0 / 0.25);
    display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start;
    color: var(--on-c); overflow: hidden;
    touch-action: none;
    transition: transform 50ms, box-shadow 50ms;
  }
  .pad:global(.down), .pad:active { transform: translateY(5px); box-shadow: 0 0 0 transparent, inset 0 2px 6px rgb(0 0 0 / 0.3); }
  .pad.sel { outline: 2px solid var(--ink); outline-offset: 2px; }
  .pads.slices { grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .pads.slices .pad { aspect-ratio: 1; min-height: 0; border-radius: 10px; padding: 5px; }
  .back { grid-column: 1 / -1; height: 26px; font-size: 10px; }
  .pad.empty { background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.15); }
  .glow { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, #fff 0%, rgb(255 255 255 / 0.5) 45%, transparent 80%); opacity: 0; pointer-events: none; }
  .num, .nm { position: relative; font-family: var(--mono); font-weight: 700; text-shadow: 0 1px 2px rgb(0 0 0 / 0.35); pointer-events: none; }
  .num { font-size: 10px; opacity: 0.8; }
  .nm { font-size: 10px; letter-spacing: 0.06em; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 900px) {
    .pads { grid-template-columns: repeat(4, 1fr); }
    .pad { aspect-ratio: 1.3; min-height: 72px; }
  }
  @media (max-width: 560px) {
    .pads { gap: 8px; }
    .pad { aspect-ratio: auto; height: 76px; min-width: 0; }
  }
</style>
