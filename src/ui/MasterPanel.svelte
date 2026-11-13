<script lang="ts">
  import { onMount } from 'svelte';
  import { autoMaster, mastered, useMasterPreset } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { driveDb, eqDb } from '../core/dsp/master';
  import { MASTER_PRESETS, MASTER_TARGETS } from '../core/mastering';
  import { app } from '../state.svelte';
  import { meterScale, onFrame } from '../visual';
  import Knob from './Knob.svelte';

  // The last thing the whole mix goes through: tone, glue, width, and a limiter that sets how loud it is.
  const m = $derived(app.project.mastering);
  let root: HTMLElement;
  let compare = $state(false);
  const rep = $derived(mastered.report);

  function setCompare(on: boolean): void {
    compare = on;
    audio.setCompare(on);
  }
  const db = (v: number) => `${eqDb(v) >= 0 ? '+' : ''}${eqDb(v).toFixed(1)}dB`;
  const width = (v: number) => (v === 64 ? 'AS MIXED' : v < 64 ? (v === 0 ? 'MONO' : `${Math.round((v / 64) * 100)}%`) : `${Math.round(100 + ((v - 64) / 63) * 100)}%`);
  const gain = (v: number) => `${driveDb(v) >= 0 ? '+' : ''}${driveDb(v).toFixed(1)}dB`;

  onMount(() => {
    const lv = new Float32Array(4);
    const off = onFrame(() => {
      const bars = root.querySelectorAll<HTMLElement>('.gr i');
      for (let i = 0; i < bars.length; i++) {
        const next = Math.max(m.on ? audio.mastering[i] : 0, lv[i] * 0.9);
        if (next === lv[i]) continue;
        lv[i] = next < 0.01 ? 0 : next;
        meterScale(bars[i], lv[i] / 12, 'X');
      }
    });
    // leaving the panel always puts the real thing back on the speakers
    return () => { off(); audio.setCompare(false); };
  });
</script>

<div class="master" class:off={!m.on} bind:this={root}>
  <section class="head">
    <h3>Mastering
      <button class="power" class:on={m.on} onclick={() => { m.on = !m.on; if (!m.on) setCompare(false); }} aria-pressed={m.on} aria-label="Mastering on/off">{m.on ? 'ON' : 'OFF'}</button>
    </h3>
    <label class="field"><span class="label">Style</span>
      <select class="pick" value="" onchange={(e) => { if (e.currentTarget.value) useMasterPreset(e.currentTarget.value); e.currentTarget.value = ''; }} aria-label="Mastering style"
        title="Set the chain up for a kind of music">
        <option value="">Choose…</option>
        {#each MASTER_PRESETS as p}<option value={p.id} title={p.blurb}>{p.name}</option>{/each}
      </select>
    </label>
    <button class="btn cmp" class:on={compare} aria-pressed={compare} disabled={!m.on} onclick={() => setCompare(!compare)}
      title="Hear the mix without the mastering, turned to the same loudness, so you are judging the sound and not the volume">{compare ? 'Hearing: before' : 'Compare with before'}</button>
    <p>{compare ? 'This is your mix without the chain, as loud as it is with it.' : 'The last thing your whole mix goes through. It is part of every export.'}</p>
  </section>

  <section>
    <h3>Tone</h3>
    <div class="k">
      <Knob bind:value={m.low} def={64} bipolar label="Low" format={db} tip="Lifts or cuts the bass of the whole mix." />
      <Knob bind:value={m.mid} def={64} bipolar label="Mid" format={db} tip="Lifts or cuts the middle, where voices and snares live." />
      <Knob bind:value={m.high} def={64} bipolar label="High" format={db} tip="Lifts or cuts the top: air and sparkle, or harshness." />
    </div>
  </section>

  <section>
    <h3>Glue and width</h3>
    <div class="k">
      <Knob bind:value={m.glue} def={40} label="Glue" tip="Compression in three bands: evens the mix out and holds it together. More is denser and louder, too much is flat." />
      <Knob bind:value={m.width} def={64} label="Width" format={width} tip="How wide the stereo picture is. All the way down is mono." />
    </div>
    <div class="grs" aria-hidden="true">
      {#each ['Low', 'Mid', 'High'] as b}<div class="gr"><i></i><span>{b}</span></div>{/each}
    </div>
  </section>

  <section>
    <h3>Loudness</h3>
    <label class="field"><span class="label">Aim for</span>
      <select class="pick" bind:value={m.target} aria-label="Loudness to aim for, in LUFS">
        {#each MASTER_TARGETS as t}<option value={t.lufs}>{t.label}</option>{/each}
      </select>
    </label>
    <div class="k">
      <Knob bind:value={m.gain} def={64} bipolar label="Gain" format={gain} tip="How hard the mix is pushed into the limiter. More is louder, until the limiter is doing all the work." />
      <button class="btn on" onclick={autoMaster} title="Play the song through the chain, measure it, and set the gain that brings it to the loudness you are aiming for">Set loudness</button>
    </div>
    <div class="gr lim" aria-hidden="true"><i></i><span>Limiter</span></div>
    {#if rep && rep.after > -69}
      <p class="rep" role="status">{rep.after.toFixed(1)} LUFS, from {rep.before.toFixed(1)}{rep.short ? ' · as loud as it goes' : ''}</p>
    {/if}
  </section>
</div>

<style>
  .master { display: grid; grid-template-columns: 1.1fr 1fr 1fr 1.1fr; gap: 10px; }
  section { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px; background: var(--inset); border-top: 3px solid var(--ink); min-height: 170px; min-width: 0; }
  .master.off section:not(.head) { opacity: 0.45; }
  h3 { margin: 0; font: 700 12px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
  p { margin: 0; font-size: 11px; color: var(--dim); line-height: 1.35; }
  .rep { color: var(--ink); font: 700 11px var(--mono); }
  .field { display: flex; align-items: center; gap: 8px; }
  .field .label { flex: 0 0 46px; }
  .field .pick { flex: 1; min-width: 0; height: 26px; font-size: 11px; }
  .k { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 2px; }
  .k .btn { margin: 0 0 6px auto; height: 30px; font-size: 10px; }
  .cmp { height: 30px; font-size: 10px; align-self: flex-start; }
  .power { border: 0; border-radius: 6px; height: 20px; padding: 0 8px; font: 700 10px var(--mono); background: var(--well); color: var(--dim); }
  .power.on { background: var(--accent); color: var(--accent-ink); }
  .grs { display: flex; flex-direction: column; gap: 3px; margin-top: auto; }
  .gr { position: relative; height: 11px; border-radius: 4px; background: var(--well); overflow: hidden; }
  .gr i { position: absolute; inset: 0; background: var(--accent); transform-origin: right; transform: scaleX(0); will-change: transform; }
  .gr span { position: absolute; left: 6px; top: 0; font: 700 7.5px/11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); }
  .gr.lim { margin-top: auto; }
  @media (max-width: 900px) { .master { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 520px) { .master { grid-template-columns: minmax(0, 1fr); } section { min-height: 0; } }
</style>
