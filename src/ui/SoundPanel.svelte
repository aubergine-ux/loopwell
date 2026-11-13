<script lang="ts">
  import { clearTrack, removeTrack } from '../actions.svelte';
  import { setKind } from '../sound.svelte';
  import { app } from '../state.svelte';
  import * as fmt from './fmt';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';
  import { usesSample } from '../core/types';
  import { plug } from '../plugins.svelte';
  import PluginEditor from './PluginEditor.svelte';
  import InstrumentEditor from './InstrumentEditor.svelte';
  import SamplerEditor from './SamplerEditor.svelte';
  import SynthEditor from './SynthEditor.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const color = $derived(`var(--t${t.color})`);
  // a track only becomes a plugin track once a plugin has been chosen for it
  function choosePlugin(): void {
    if (t.kind === 'plugin') return;
    if (t.plugins.length) { setKind(app.sel, 'plugin'); return; }
    plug.pick = { track: app.sel, index: 0 };
    app.modal = 'plugins';
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
      <button class:on={t.kind === 'drum'} onclick={() => setKind(app.sel, 'drum')} title="One sample, played on steps">Drum</button>
      <button class:on={t.kind === 'slice'} onclick={() => setKind(app.sel, 'slice')} title="A sample chopped into slices you play like notes">Slice</button>
      <button class:on={t.kind === 'synth'} onclick={() => setKind(app.sel, 'synth')}>Synth</button>
      <button class:on={t.kind === 'bass'} onclick={() => setKind(app.sel, 'bass')} title="808 bass: one sliding, saturated voice that follows the song's key">808</button>
      <button class:on={t.kind === 'dsyn'} onclick={() => setKind(app.sel, 'dsyn')} title="Drum synth: kicks, snares, hats and claps made from knobs instead of samples">Knobs</button>
      <button class:on={t.kind === 'plugin'} onclick={choosePlugin} title="Plugin: an instrument made by someone else, in the Web Audio Modules format">Plugin</button>
    </div>
    <div class="idbtns">
      <button class="btn ghost" onclick={() => clearTrack(app.sel)} title="Clear this track in the current pattern (Shift+Backspace)">Clear</button>
      <button class="btn ghost sq" onclick={() => removeTrack(app.sel)} disabled={p.tracks.length <= 1} aria-label="Delete track" title="Delete track"><Icon name="trash" size={14} /></button>
    </div>
  </div>

  <div class="source">
    {#if t.kind === 'synth'}<SynthEditor />{:else if t.kind === 'plugin'}<PluginEditor />{:else if usesSample(t.kind)}<SamplerEditor />{:else}<InstrumentEditor />{/if}
  </div>

  <div class="strip">
    <div class="krow">
      {#if usesSample(t.kind)}
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
  .sound { display: grid; grid-template-columns: 196px minmax(0, 1fr) auto; gap: 18px; align-items: start; }
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
  .id .seg { flex-wrap: wrap; }
  .id .seg button { min-width: 0; padding: 0 8px; }
  .source { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .krow { display: flex; flex-wrap: wrap; gap: 4px 2px; align-items: flex-start; }
  .strip { padding-left: 18px; border-left: 1px solid var(--line); min-height: 100%; }
  .strip .krow { display: grid; grid-template-columns: repeat(2, auto); justify-content: start; }
  @media (max-width: 1100px) {
    .sound { grid-template-columns: 1fr; }
    .id { flex-direction: row; flex-wrap: wrap; align-items: center; }
    .namerow { width: 180px; }
    .strip { padding-left: 0; border-left: 0; }
    .strip .krow { display: flex; }
  }
</style>
