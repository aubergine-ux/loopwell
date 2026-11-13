<script lang="ts">
  import { onMount } from 'svelte';
  import { audio } from '../audio/host';
  import { DELAY_LABELS } from '../core/types';
  import { app } from '../state.svelte';
  import { meterScale, onFrame } from '../visual';
  import * as fmt from './fmt';
  import Knob from './Knob.svelte';

  let gr: HTMLElement;
  const fx = $derived(app.project.fx);

  onMount(() => {
    let lv = 0;
    return onFrame(() => {
      const next = Math.max(audio.reduction, lv * 0.9);
      if (next === lv) return;
      lv = next < 0.01 ? 0 : next;
      meterScale(gr, lv / 18, 'X');
    });
  });
</script>

<div class="fx">
  <section style:--c="var(--t4)">
    <h3>Reverb</h3>
    <p>Send from each track's <b>Reverb</b> knob</p>
    <div class="k">
      <Knob bind:value={fx.revSize} def={70} label="Size" color="var(--t4)" />
      <Knob bind:value={fx.revDamp} def={60} label="Damp" color="var(--t4)" />
      <Knob bind:value={fx.revLevel} def={90} label="Level" color="var(--t4)" />
    </div>
  </section>
  <section style:--c="var(--t6)">
    <h3>Delay</h3>
    <div class="seg times">
      {#each DELAY_LABELS as l, i}
        <button class:on={fx.dlyTime === i} onclick={() => (fx.dlyTime = i)}>{l}</button>
      {/each}
    </div>
    <div class="k">
      <Knob bind:value={fx.dlyFb} def={50} label="Feedback" color="var(--t6)" />
      <Knob bind:value={fx.dlyLevel} def={90} label="Level" color="var(--t6)" />
    </div>
  </section>
  <section style:--c="var(--t1)">
    <h3>Filter</h3>
    <p>Left sweeps a low-pass, right a high-pass</p>
    <div class="k">
      <Knob bind:value={fx.filter} min={-64} max={63} def={0} bipolar label="Sweep" size={64} format={fmt.filter} color="var(--t1)" />
      <Knob bind:value={fx.filterRes} def={30} label="Reso" color="var(--t1)" />
    </div>
  </section>
  <section style:--c="var(--t0)">
    <h3>
      Compressor
      <button class="power" class:on={fx.compOn} onclick={() => (fx.compOn = !fx.compOn)} aria-pressed={fx.compOn} aria-label="Compressor on/off">{fx.compOn ? 'ON' : 'OFF'}</button>
    </h3>
    <div class="gr" title="Gain reduction"><i bind:this={gr}></i><span class="label">GR</span></div>
    <div class="k" class:dim={!fx.compOn}>
      <Knob bind:value={fx.compThresh} def={40} label="Thresh" format={(v) => `${-Math.round((v / 127) * 36)}dB`} color="var(--t0)" />
      <Knob bind:value={fx.compRatio} def={40} label="Ratio" format={(v) => `${(1 + (v / 127) * 11).toFixed(1)}:1`} color="var(--t0)" />
      <Knob bind:value={fx.compMakeup} def={20} label="Makeup" format={(v) => `+${Math.round((v / 127) * 18)}dB`} color="var(--t0)" />
    </div>
  </section>
</div>

<style>
  .fx { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  section {
    display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px;
    background: var(--inset); border-top: 3px solid var(--c); min-height: 170px;
  }
  h3 { margin: 0; font: 700 12px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
  p { margin: 0; font-size: 11px; color: var(--dim); line-height: 1.3; }
  p b { color: var(--ink); font-weight: 600; }
  .k { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 2px; margin-top: auto; }
  .k.dim { opacity: 0.45; }
  .times { align-self: flex-start; flex-wrap: wrap; }
  .times button { min-width: 0; padding: 0 6px; font-size: 10px; }
  .power { border: 0; border-radius: 6px; height: 20px; padding: 0 8px; font: 700 10px var(--mono); background: var(--well); color: var(--dim); }
  .power.on { background: var(--c); color: #fff; }
  .gr { position: relative; height: 12px; border-radius: 4px; background: var(--well); overflow: hidden; }
  .gr i { position: absolute; inset: 0; background: var(--c); transform-origin: right; transform: scaleX(0); }
  .gr .label { position: absolute; left: 6px; top: 1px; font-size: 8px; color: var(--ink); mix-blend-mode: normal; }
  @media (max-width: 900px) { .fx { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
