<script lang="ts">
  import { checkpoint, toast } from '../actions.svelte';
  import { pluginUrlOk } from '../core/types';
  import { isDesktop } from '../desktop';
  import { BUILTIN_PLUGINS, loadCommunity, plug, setPlugin, type PluginEntry } from '../plugins.svelte';
  import { setKind } from '../sound.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  const pick = plug.pick ?? { track: app.sel, index: 0 };
  const track = $derived(app.project.tracks[pick.track]);
  // the first plugin on a track plays its notes; any after it treat its sound
  const wantInstrument = pick.index === 0;
  let query = $state('');
  let address = $state('');
  let addressError = $state('');

  const match = (e: PluginEntry) => {
    const q = query.trim().toLowerCase();
    return !q || `${e.name} ${e.vendor} ${e.description}`.toLowerCase().includes(q);
  };
  // the kind being looked for comes first; the rest stay reachable, because the community's labels are not always right
  const order = (list: PluginEntry[]) => list.filter(match).sort((a, b) => Number(b.instrument === wantInstrument) - Number(a.instrument === wantInstrument));
  const builtin = $derived(order(BUILTIN_PLUGINS));
  const community = $derived(order(plug.community));

  function choose(e: { url: string; name: string }): void {
    checkpoint();
    if (!setPlugin(pick.track, pick.index, e)) { toast('That plugin could not be added.', 'error'); return; }
    if (track.kind !== 'plugin') setKind(pick.track, 'plugin');
    plug.pick = null;
    app.modal = null;
    app.tab = 'sound';
  }

  function fromAddress(): void {
    const url = address.trim();
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) { addressError = 'The address has to start with https:// (or http://localhost while you are building one).'; return; }
    if (!pluginUrlOk(url)) { addressError = 'That does not look like the address of a plugin.'; return; }
    addressError = '';
    const name = url.replace(/\/(index|main)\.m?js$/, '').split('/').filter(Boolean).pop() ?? 'Plugin';
    choose({ url, name });
  }
</script>

{#snippet row(e: PluginEntry)}
  <button class="plugin" onclick={() => choose(e)}>
    {#if e.thumbnail}<img src={e.thumbnail} alt="" loading="lazy" />{:else}<span class="thumb"><Icon name={e.instrument ? 'note' : 'wave'} size={20} /></span>{/if}
    <span class="text">
      <b>{e.name} <i class="kind" class:other={e.instrument !== wantInstrument}>{e.instrument ? 'Instrument' : 'Effect'}</i></b>
      <small>{e.vendor}</small>
      <span>{e.description}</span>
    </span>
  </button>
{/snippet}

<Modal title="Plugins" wide>
  <p class="for">{wantInstrument ? 'An instrument' : 'An effect'} for <b>{track?.name ?? 'this track'}</b>{wantInstrument ? '' : ', after what is already on it'}.</p>
  <input class="search" type="search" bind:value={query} placeholder="Search plugins" aria-label="Search plugins" spellcheck="false" />


  <section>
    <h3>Comes with Loopwell</h3>
    <div class="list">
      {#each builtin as e (e.url)}{@render row(e)}{:else}<p class="none">Nothing here matches “{query}”.</p>{/each}
    </div>
  </section>

  {#if !isDesktop}
    <section>
      <h3>From the Web Audio Modules community</h3>
      {#if plug.communityState === 'idle'}
        <p class="note">A list of plugins other people have made and published, kept at webaudiomodules.com. Loopwell has not checked them: a plugin is a program, and once you choose one it runs on this page.</p>
        <button class="btn" onclick={loadCommunity}><Icon name="download" size={14} />Show the community's plugins</button>
      {:else if plug.communityState === 'loading'}
        <p class="note" role="status">Fetching the list…</p>
      {:else if plug.communityState === 'error'}
        <p class="note" role="alert">The list could not be fetched. It needs a connection to webaudiomodules.com.</p>
        <button class="btn" onclick={() => { plug.communityState = 'idle'; void loadCommunity(); }}>Try again</button>
      {:else}
        <p class="note">Made by other people and not checked by Loopwell. Choosing one loads and runs its code.</p>
        <div class="list">
          {#each community as e (e.url)}{@render row(e)}{:else}<p class="none">Nothing here matches “{query}”.</p>{/each}
        </div>
      {/if}
    </section>

    <section>
      <h3>From an address</h3>
      <p class="note">The address of any WAM 2.0 plugin's index.js: one you found, or one you are building (see docs/plugins.md).</p>
      <form onsubmit={(e) => { e.preventDefault(); fromAddress(); }}>
        <input bind:value={address} placeholder="https://example.org/my-plugin/index.js" aria-label="Address of a plugin" spellcheck="false" autocapitalize="off" />
        <button class="btn" disabled={!address.trim()}>Load it</button>
      </form>
      {#if addressError}<p class="error" role="alert">{addressError}</p>{/if}
    </section>
  {/if}
</Modal>

<style>
  .for { margin: 0 0 10px; font-size: 14px; }
  .search, form input {
    width: 100%; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text; min-width: 0;
  }
  section { margin-top: 18px; }
  h3 { margin: 0 0 8px; font: 600 10px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
  .plugin {
    display: flex; gap: 12px; align-items: center; text-align: left; padding: 10px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--raise); box-shadow: 0 2px 0 var(--edge); min-width: 0;
  }
  .plugin:hover { border-color: var(--accent); }
  .plugin:active { transform: translateY(2px); box-shadow: none; }
  .plugin img, .thumb { flex: none; width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--inset); }
  .thumb { display: grid; place-items: center; color: var(--dim); }
  .text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .text b { font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .kind { font: 600 9px var(--mono); font-style: normal; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 6px; border-radius: 6px; background: var(--accent); color: var(--accent-ink); }
  .kind.other { background: var(--well); color: var(--dim); }
  .text small { font: 600 10px var(--mono); color: var(--dim); }
  .text span { font-size: 12px; line-height: 1.35; color: var(--dim); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .note, .none { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: var(--dim); max-width: 64ch; }
  form { display: flex; gap: 8px; }
  form .btn { height: 36px; flex: none; }
  .error { margin: 8px 0 0; padding: 8px 12px; border-radius: 10px; background: var(--rec); color: var(--on-c); font-size: 13px; }
</style>
