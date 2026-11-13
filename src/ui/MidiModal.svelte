<script lang="ts">
  import { connectMidi } from '../audio/midi-in';
  import {
    canFollow, clearMappings, deleteSet, loadSet, midimap, removeMapping, saveSet, setFollow, setLearning, sourceLabel,
  } from '../midimap.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let name = $state('');
  const sets = $derived(Object.keys(midimap.saved).sort());
  $effect(() => { if (!name && app.midi.inputs.length) name = app.midi.inputs[0].slice(0, 30); });

  function learn(): void {
    setLearning(true);
    app.modal = null;
  }
  function keep(e: Event): void {
    e.preventDefault();
    saveSet(name);
  }
</script>

<Modal title="MIDI">
  {#if app.midi.state === 'unsupported'}
    <p>This browser doesn't support Web MIDI. Chrome, Edge, Opera and Firefox do.</p>
  {:else if app.midi.state !== 'on'}
    <p>{app.midi.state === 'denied' ? 'MIDI access was blocked. Allow it in the site settings, then try again.' : 'Plug in a controller, then allow access.'}</p>
    <button class="btn on" onclick={connectMidi}>Connect MIDI</button>
  {:else}
    <p>{#if app.midi.inputs.length}Connected: <b>{app.midi.inputs.join(', ')}</b>{:else}MIDI is on. Plug in a controller and it will show up here.{/if}</p>
  {/if}

  <h3>Controller mappings</h3>
  <p class="small">Tie any knob or fader on screen to a knob on your controller: press <b>Learn</b>, click the control, then move the one on your controller.
    The effect pad on the Live screen can be learned too.</p>
  <div class="row">
    <button class="btn on" onclick={learn} disabled={app.midi.state !== 'on'}>Learn</button>
    <button class="btn ghost" onclick={clearMappings} disabled={!midimap.maps.length}>Clear all</button>
  </div>

  {#if midimap.maps.length}
    <ul class="maps">
      {#each midimap.maps as m (m.from)}
        <li>
          <span class="from" title={m.device}>{sourceLabel(m.from)}</span>
          <span class="to">{m.label}</span>
          {#if canFollow(m)}
            <label title="Move this knob on whichever track is selected, instead of always the same track">
              <input type="checkbox" checked={m.follow} onchange={(e) => setFollow(m.from, e.currentTarget.checked)} /> selected track
            </label>
          {/if}
          <button class="btn ghost sq" onclick={() => removeMapping(m.from)} aria-label="Remove the mapping for {m.label}"><Icon name="trash" size={13} /></button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No mappings yet.</p>
  {/if}

  <h3>Saved sets</h3>
  <form class="row" onsubmit={keep}>
    <input bind:value={name} maxlength="30" placeholder="Name, e.g. your controller" aria-label="Name for this set of mappings" spellcheck="false" />
    <button class="btn" disabled={!name.trim() || !midimap.maps.length}>Save these</button>
  </form>
  {#if sets.length}
    <ul class="maps">
      {#each sets as s (s)}
        <li>
          <span class="to">{s}</span>
          <span class="from">{midimap.saved[s].length} mapping{midimap.saved[s].length === 1 ? '' : 's'}</span>
          <button class="btn" onclick={() => loadSet(s)}>Load</button>
          <button class="btn ghost sq" onclick={() => deleteSet(s)} aria-label="Delete the saved set {s}"><Icon name="trash" size={13} /></button>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="small">Without a mapping: pad controllers (notes from C1, or anything on channel 10) hit the pads, keyboards play the selected track, CC7 is volume,
    CC1 the master filter, CC74 synth cutoff, and MIDI start/stop drive the transport.</p>
</Modal>

<style>
  h3 { margin: 16px 0 8px; font: 700 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; }
  .small { color: var(--dim); font-size: 12px; }
  .empty { color: var(--dim); font-size: 12px; margin-top: 10px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input {
    flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  .maps { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .maps li { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 10px; border-radius: 9px; background: var(--inset); font: 600 12px var(--mono); }
  .from { color: var(--dim); white-space: nowrap; }
  .to { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .maps label { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dim); white-space: nowrap; }
  .maps .btn { height: 26px; font-size: 10px; }
</style>
