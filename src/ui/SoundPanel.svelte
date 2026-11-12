<script lang="ts">
  import { assignSample, clearTrack, handleFiles, removeTrack, sampleMissing, sampleName, useKit } from '../actions.svelte';
  import { KITS, SLOTS, isBuiltin, slotLabel } from '../core/kits';
  import { noteName } from '../core/scales';
  import { WAVES } from '../core/types';
  import { app } from '../state.svelte';
  import * as fmt from './fmt';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const color = $derived(`var(--t${t.color})`);
  let kit = $state(KITS[0].id);
  let picker = $state<HTMLInputElement>();

  // follow the selected track's kit
  $effect(() => {
    if (t.kind === 'drum' && isBuiltin(t.sample)) kit = t.sample.split('/')[0];
  });

  const WAVE_ICON = ['M3 16 12 6v10l9-10', 'M3 16V7h6v9h6V7h6', 'm3 16 5-9 6 9 5-9 2 4', 'M3 12c3-9 6-9 9 0s6 9 9 0'];

  function pick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) void handleFiles([...input.files], app.sel);
    input.value = '';
  }
</script>

<div class="sound" style:--c={color}>
  <div class="id">
    <div class="namerow">
      <i class="dot"></i>
      <input class="name" bind:value={t.name} maxlength="12" aria-label="Track name" spellcheck="false"
        oninput={(e) => (t.name = (e.currentTarget as HTMLInputElement).value.toUpperCase())} />
    </div>
    <div class="seg">
      <button class:on={t.kind === 'drum'} onclick={() => (t.kind = 'drum')}>Drum</button>
      <button class:on={t.kind === 'synth'} onclick={() => (t.kind = 'synth')}>Synth</button>
    </div>
    <div class="idbtns">
      <button class="btn ghost" onclick={() => clearTrack(app.sel)} title="Clear this track in the current pattern (Shift+Backspace)">Clear</button>
      <button class="btn ghost sq" onclick={() => removeTrack(app.sel)} disabled={p.tracks.length <= 1} aria-label="Delete track" title="Delete track"><Icon name="trash" size={14} /></button>
    </div>
  </div>

  <div class="source">
    {#if t.kind === 'drum'}
      <div class="kits">
        <div class="seg">
          {#each KITS as k}
            <button class:on={kit === k.id} onclick={() => (kit = k.id)} title={k.blurb}>{k.name}</button>
          {/each}
        </div>
        <button class="btn ghost" onclick={() => useKit(kit)} title="Switch every drum track to the {kit} kit">Kit → all</button>
        <button class="btn ghost" onclick={() => picker?.click()} title="Use your own audio file. You can also drop one on a track."><Icon name="open" size={14} />Load</button>
        <input bind:this={picker} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.m4a" multiple hidden onchange={pick} />
      </div>
      <div class="slots">
        {#each SLOTS as s}
          {@const id = `${kit}/${s}`}
          <button class="slot" class:on={t.sample === id} onclick={() => assignSample(app.sel, id)}>{slotLabel(id)}</button>
        {/each}
      </div>
      {#if !isBuiltin(t.sample)}
        <div class="custom" class:missing={sampleMissing(t.sample)}>
          <Icon name="file" size={13} />
          {#if sampleMissing(t.sample)}
            Custom sample not on this device. Drop a file here or pick a sound above.
          {:else}
            {sampleName(t.sample)}
          {/if}
        </div>
      {/if}
    {:else}
      <div class="waves">
        {#each WAVES as w, i}
          <button class="wave" class:on={t.synth.wave === i} onclick={() => (t.synth.wave = i)} aria-label="{w} wave" title={w}>
            <svg viewBox="0 0 24 22" width="30" height="26"><path d={WAVE_ICON[i]} /></svg>
          </button>
        {/each}
        <div class="rootnote">
          <span class="label">Root</span>
          <div class="stepper">
            <button onclick={() => (t.note = Math.max(12, t.note - 12))} aria-label="Octave down">−</button>
            <b>{noteName(t.note)}</b>
            <button onclick={() => (t.note = Math.min(96, t.note + 12))} aria-label="Octave up">+</button>
          </div>
        </div>
      </div>
      <div class="krow">
        <Knob bind:value={t.synth.cutoff} def={70} label="Cutoff" {color} />
        <Knob bind:value={t.synth.reso} def={30} label="Reso" {color} />
        <Knob bind:value={t.synth.env} def={60} label="Env" {color} />
        <span class="div"></span>
        <Knob bind:value={t.synth.attack} def={0} label="Attack" {color} />
        <Knob bind:value={t.synth.decay} def={50} label="Decay" {color} />
        <Knob bind:value={t.synth.sustain} def={40} label="Sustain" {color} />
        <Knob bind:value={t.synth.release} def={30} label="Release" {color} />
      </div>
    {/if}
  </div>

  <div class="strip">
    <div class="krow">
      {#if t.kind === 'drum'}
        <Knob bind:value={t.tune} min={-24} max={24} def={0} bipolar label="Tune" format={fmt.semis} {color} />
        <Knob bind:value={t.decay} def={127} label="Decay" format={fmt.decay} {color} />
      {/if}
      <Knob bind:value={t.filter} min={-64} max={63} def={0} bipolar label="Filter" format={fmt.filter} {color} />
      <Knob bind:value={t.vol} def={100} label="Level" {color} />
      <Knob bind:value={t.pan} min={-64} max={63} def={0} bipolar label="Pan" format={fmt.pan} {color} />
      <Knob bind:value={t.rev} def={0} label="Reverb" {color} />
      <Knob bind:value={t.dly} def={0} label="Delay" {color} />
    </div>
  </div>
</div>

<style>
  .sound { display: grid; grid-template-columns: 170px minmax(0, 1fr) auto; gap: 18px; align-items: start; }
  .id { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .namerow { display: flex; align-items: center; gap: 8px; width: 100%; }
  .dot { flex: none; width: 14px; height: 14px; border-radius: 5px; background: var(--c); }
  .name {
    flex: 1; min-width: 0; height: 32px; padding: 0 8px; border-radius: 8px;
    border: 1px solid transparent; background: var(--inset);
    font: 700 13px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
    user-select: text; -webkit-user-select: text;
  }
  .name:focus { border-color: var(--c); outline: none; }
  .idbtns { display: flex; gap: 2px; margin-left: -8px; }
  .source { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .kits { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .kits .btn { height: 30px; padding: 0 8px; font-size: 10px; }
  .slots { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .slot {
    height: 34px; border-radius: 9px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 2px 0 var(--edge), inset 0 1px 0 var(--hi);
    font: 600 10px var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px;
    touch-action: manipulation;
  }
  .slot:active { transform: translateY(2px); box-shadow: none; }
  .slot.on { background: var(--c); color: #fff; border-color: transparent; text-shadow: 0 1px 1px rgb(0 0 0 / 0.3); }
  .custom {
    display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: 8px;
    background: var(--inset); font: 600 11px var(--mono); color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .custom.missing { color: var(--rec); white-space: normal; }
  .waves { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .wave {
    width: 46px; height: 38px; border-radius: 9px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 2px 0 var(--edge), inset 0 1px 0 var(--hi); display: grid; place-items: center; padding: 0;
  }
  .wave path { fill: none; stroke: var(--dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .wave.on { background: var(--c); border-color: transparent; }
  .wave.on path { stroke: #fff; }
  .rootnote { display: flex; flex-direction: column; gap: 3px; margin-left: 10px; }
  .stepper { display: flex; align-items: center; background: var(--inset); border-radius: 8px; height: 26px; }
  .stepper button { width: 24px; height: 26px; border: 0; background: none; font: 700 14px var(--mono); color: var(--dim); }
  .stepper b { font: 700 11px var(--mono); min-width: 30px; text-align: center; }
  .krow { display: flex; flex-wrap: wrap; gap: 4px 2px; align-items: flex-start; }
  .div { width: 1px; align-self: stretch; background: var(--line); margin: 4px 6px; }
  .strip { padding-left: 18px; border-left: 1px solid var(--line); min-height: 100%; }
  .strip .krow { display: grid; grid-template-columns: repeat(4, auto); justify-content: start; }
  @media (max-width: 1100px) {
    .sound { grid-template-columns: 1fr; }
    .id { flex-direction: row; flex-wrap: wrap; align-items: center; }
    .namerow { width: 180px; }
    .strip { padding-left: 0; border-left: 0; }
    .strip .krow { display: flex; }
  }
</style>
