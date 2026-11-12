<script lang="ts">
  import { onMount } from 'svelte';
  import { padDown, padUp } from '../actions.svelte';
  import { app } from '../state.svelte';
  import { onFlash } from '../visual';

  let root: HTMLElement;
  const p = $derived(app.project);
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

  onMount(() => onFlash((t, vel) => {
    const glow = root.querySelector(`.pad[data-pad="${t}"] .glow`);
    glow?.animate([{ opacity: 0.35 + (vel / 127) * 0.65 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
  }));
</script>

<div class="pads" bind:this={root}>
  {#each { length: 8 } as _, i}
    {@const t = p.tracks[i]}
    {#if t}
      <button class="pad" class:sel={app.sel === i} data-pad={i} style:--c="var(--t{t.color})" aria-label="Pad {i + 1}: {t.name}"
        onpointerdown={(e) => down(e, i)} onpointerup={up} onpointercancel={up} oncontextmenu={(e) => e.preventDefault()}>
        <i class="glow"></i>
        <span class="num">{i + 1}</span>
        <span class="nm">{t.name}</span>
      </button>
    {:else}
      <div class="pad empty"></div>
    {/if}
  {/each}
</div>

<style>
  .pads { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; align-content: start; }
  .pad {
    position: relative; aspect-ratio: 1.32; min-height: 58px;
    border: 0; border-radius: 14px; padding: 8px;
    background: color-mix(in srgb, var(--c) 82%, var(--panel));
    box-shadow: 0 5px 0 color-mix(in srgb, var(--c) 55%, #000), inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 -10px 18px -10px rgb(0 0 0 / 0.25);
    display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start;
    color: #fff; overflow: hidden;
    touch-action: none;
    transition: transform 50ms, box-shadow 50ms;
  }
  .pad:global(.down), .pad:active { transform: translateY(5px); box-shadow: 0 0 0 transparent, inset 0 2px 6px rgb(0 0 0 / 0.3); }
  .pad.sel { outline: 2px solid var(--ink); outline-offset: 2px; }
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
