<script lang="ts">
  import { toast } from '../actions.svelte';
  import { PRESETS, PRESET_GROUPS, type Preset } from '../core/presets';
  import { applyPreset, deleteUserPreset, saveUserPreset, userPresets } from '../sound.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  const t = $derived(app.project.tracks[app.sel]);
  let mine = $state<Preset[]>(userPresets());
  let group = $state(PRESET_GROUPS[0]);
  let name = $state('');
  let last = $state('');
  const groups = $derived(mine.length ? [...PRESET_GROUPS, 'Mine'] : PRESET_GROUPS);
  const list = $derived(group === 'Mine' ? mine : PRESETS.filter((x) => x.group === group));

  function load(x: Preset): void {
    applyPreset(app.sel, x);
    last = `${x.group}/${x.name}`;
  }
  function save(): void {
    const n = name.trim();
    if (!n) return;
    if (!saveUserPreset(n, t.synth, t.note)) { toast('This browser would not store the preset.', 'error'); return; }
    mine = userPresets();
    group = 'Mine';
    name = '';
  }
  function remove(x: Preset): void {
    deleteUserPreset(x.name);
    mine = userPresets();
    if (!mine.length) group = PRESET_GROUPS[0];
  }
</script>

<Modal title="Sounds for {t.name}">
  <div class="seg groups">
    {#each groups as g}
      <button class:on={group === g} onclick={() => (group = g)}>{g}</button>
    {/each}
  </div>
  <div class="list" style:--c="var(--t{t.color})">
    {#each list as x}
      <div class="item">
        <button class="load" class:on={last === `${x.group}/${x.name}`} onclick={() => load(x)}>{x.name}</button>
        {#if x.group === 'Mine'}<button class="btn ghost sq" onclick={() => remove(x)} aria-label="Delete preset {x.name}"><Icon name="trash" size={13} /></button>{/if}
      </div>
    {/each}
  </div>
  {#if t.kind === 'synth'}
    <form class="save" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <input bind:value={name} maxlength="24" placeholder="Name this track's sound" aria-label="Preset name" spellcheck="false" />
      <button class="btn" disabled={!name.trim()}>Save as preset</button>
    </form>
  {/if}
</Modal>

<style>
  .groups { margin: 4px 0 12px; flex-wrap: wrap; }
  .list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .item { display: flex; gap: 2px; }
  .load {
    flex: 1; height: 40px; border-radius: 10px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 2px 0 var(--edge), inset 0 1px 0 var(--hi); font: 600 12px var(--mono);
  }
  .load:active { transform: translateY(2px); box-shadow: none; }
  .load.on { background: var(--c); color: var(--on-c); border-color: transparent; }
  .save { display: flex; gap: 8px; margin-top: 16px; }
  .save input {
    flex: 1; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  @media (max-width: 520px) { .list { grid-template-columns: repeat(2, 1fr); } }
</style>
