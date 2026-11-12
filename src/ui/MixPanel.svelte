<script lang="ts">
  import { onMount } from 'svelte';
  import { audio } from '../audio/host';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';
  import Fader from './Fader.svelte';
  import * as fmt from './fmt';
  import Knob from './Knob.svelte';

  let root: HTMLElement;
  const p = $derived(app.project);

  onMount(() => {
    const lv = new Float32Array(10);
    return onFrame(() => {
      const bars = root.querySelectorAll<HTMLElement>('.vu i');
      const n = p.tracks.length;
      bars.forEach((el, i) => {
        const src = i < n ? audio.peaks[i] : i === n ? audio.masterL : audio.masterR;
        const next = Math.max(src, lv[i] * 0.880);
        if (next === lv[i]) return;
        lv[i] = next < 0.001 ? 0 : next;
        el.style.transform = `scaleY(${Math.min(1, Math.sqrt(lv[i])).toFixed(3)})`;
      });
    });
  });
</script>

<div class="mix" bind:this={root}>
  {#each p.tracks as t, i (i)}
    {@const color = `var(--t${t.color})`}
    <div class="ch" class:sel={app.sel === i} style:--c={color}>
      <button class="nm" onclick={() => (app.sel = i)}>{t.name}</button>
      <div class="sends">
        <Knob bind:value={t.pan} min={-64} max={63} def={0} bipolar label="Pan" size={34} format={fmt.pan} {color} />
        <Knob bind:value={t.rev} def={0} label="Rev" size={34} {color} />
        <Knob bind:value={t.dly} def={0} label="Dly" size={34} {color} />
      </div>
      <div class="fd">
        <div class="vu"><i></i></div>
        <Fader bind:value={t.vol} label="{t.name} level" {color} />
      </div>
      <div class="msrow">
        <button class="ms" class:on={t.mute} onclick={() => (t.mute = !t.mute)} aria-pressed={t.mute} aria-label="Mute {t.name}">M</button>
        <button class="ms solo" class:on={t.solo} onclick={() => (t.solo = !t.solo)} aria-pressed={t.solo} aria-label="Solo {t.name}">S</button>
      </div>
    </div>
  {/each}
  <div class="ch master">
    <span class="nm">MASTER</span>
    <div class="fd tall">
      <div class="vu"><i></i></div>
      <div class="vu"><i></i></div>
      <Fader bind:value={p.master} label="Master level" color="var(--ink)" height={168} />
    </div>
  </div>
</div>

<style>
  .mix { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
  .ch {
    flex: 1 1 0; min-width: 96px; display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 8px 6px 10px; border-radius: 12px; background: var(--inset);
    border-top: 3px solid var(--c);
  }
  .ch.sel { box-shadow: 0 0 0 2px var(--c) inset; }
  .ch.master { border-top-color: var(--ink); flex: 0 0 78px; min-width: 78px; }
  .nm {
    border: 0; background: none; padding: 0; max-width: 100%;
    font: 700 10px var(--mono); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sends { display: flex; }
  .sends :global(.knob) { min-width: 0; padding: 0 1px; }
  .sends :global(.label) { font-size: 8px; }
  .fd { display: flex; gap: 6px; align-items: stretch; }
  .fd.tall { flex: 1; align-items: flex-end; }
  .vu { width: 5px; border-radius: 3px; background: var(--well); overflow: hidden; display: flex; align-items: flex-end; }
  .vu i { display: block; width: 100%; height: 100%; background: var(--c, var(--ink)); transform-origin: bottom; transform: scaleY(0); }
  .msrow { display: flex; gap: 4px; }
  .ms {
    width: 26px; height: 22px; padding: 0; border-radius: 6px; border: 1px solid var(--line); background: var(--raise);
    color: var(--dim); font: 700 10px var(--mono);
  }
  .ms.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .ms.solo.on { background: var(--t2); color: #221a00; }
</style>
