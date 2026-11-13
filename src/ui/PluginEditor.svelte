<script lang="ts">
  import { checkpoint } from '../actions.svelte';
  import { MAX_PLUGINS } from '../core/types';
  import { allowTrack, plug, pluginHost, removePlugin, retryTrack } from '../plugins.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  const t = $derived(app.project.tracks[app.sel]);
  const slots = $derived(plug.tracks[app.sel] ?? []);
  const asking = $derived(slots.some((s) => s.status === 'ask'));
  // where the plugins waiting for a yes come from, each place named once
  const from = $derived([...new Set(slots.filter((s) => s.status === 'ask').map((s) => pluginHost(s.url)))].join(', '));

  function browse(index: number): void {
    plug.pick = { track: app.sel, index };
    app.modal = 'plugins';
  }
  function open(index: number): void {
    plug.open = { track: app.sel, index };
    app.modal = 'plugin';
  }
  function remove(index: number): void {
    checkpoint();
    removePlugin(app.sel, index);
  }
</script>

<div class="plugs">
  {#if !t.plugins.length}
    <div class="empty">
      <b>No plugin on this track yet</b>
      <span>A plugin is an instrument or effect made by someone else, in the Web Audio Modules format. It plays this track's notes and goes through its mixer strip like any other sound.</span>
      <button class="btn on" onclick={() => browse(0)}><Icon name="search" size={14} />Choose a plugin</button>
    </div>
  {:else}
    {#if asking}
      <div class="ask" role="alert">
        <b>This beat wants to load {slots.length === 1 ? 'a plugin' : 'plugins'} from {from}.</b>
        <span>A plugin is a program written by someone else. Once loaded it can do anything on this page that Loopwell can, so load it only if you trust where it comes from. Until then this track stays silent.</span>
        <button class="btn" onclick={() => allowTrack(app.sel)}>Load {slots.length === 1 ? 'it' : 'them'}</button>
      </div>
    {/if}
    <ol class="chain">
      {#each t.plugins as r, i (i + r.url)}
        {@const s = slots[i]}
        <li class:bad={s?.status === 'error'}>
          <span class="label">{i === 0 ? 'Instrument' : `Effect ${i}`}</span>
          <div class="who">
            <b>{s?.name ?? r.name}</b>
            <small>{s?.vendor || pluginHost(r.url)}</small>
          </div>
          <span class="status" role="status">
            {#if s?.status === 'loading'}Loading…{:else if s?.status === 'error'}{s.error}{:else if s?.status === 'ask'}Waiting for your say-so{/if}
          </span>
          <div class="btns">
            {#if s?.status === 'error'}<button class="btn" onclick={() => retryTrack(app.sel)}>Try again</button>{/if}
            <button class="btn" disabled={s?.status !== 'ready'} onclick={() => open(i)} title="Open the plugin's own controls">Open</button>
            <button class="btn ghost" onclick={() => browse(i)} title="Put a different plugin here">Change</button>
            <button class="btn ghost sq" onclick={() => remove(i)} aria-label="Remove {r.name}" title="Remove"><Icon name="x" size={13} /></button>
          </div>
        </li>
      {/each}
    </ol>
    {#if t.plugins.length < MAX_PLUGINS}
      <button class="btn ghost add" onclick={() => browse(t.plugins.length)}><Icon name="plus" size={13} />Add an effect plugin after {t.plugins.length === 1 ? 'it' : 'these'}</button>
    {/if}
  {/if}
</div>

<style>
  .plugs { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .empty, .ask { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 14px 16px; border-radius: 12px; background: var(--inset); font-size: 13px; line-height: 1.45; }
  .ask { background: color-mix(in srgb, var(--t1) 20%, var(--panel)); }
  .empty span, .ask span { color: var(--dim); max-width: 60ch; }
  .ask span { color: inherit; }
  .chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li {
    display: grid; grid-template-columns: 76px minmax(0, 1fr) minmax(0, 1.2fr) auto; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 10px; background: var(--inset); border: 1px solid transparent;
  }
  li.bad { border-color: var(--rec); }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who small { font: 600 10px var(--mono); color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 12px; color: var(--dim); min-width: 0; }
  li.bad .status { color: var(--ink); }
  .btns { display: flex; gap: 4px; align-items: center; }
  .btns .btn { height: 28px; font-size: 10px; padding: 0 9px; }
  .btns .btn.sq { width: 28px; padding: 0; }
  .add { align-self: flex-start; height: 28px; font-size: 10px; }
  @media (max-width: 720px) {
    li { grid-template-columns: minmax(0, 1fr) auto; }
    li .label, li .status { grid-column: 1 / -1; }
  }
</style>
