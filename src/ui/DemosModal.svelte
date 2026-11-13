<script lang="ts">
  import { play } from '../actions.svelte';
  import { DEMOS } from '../core/demos';
  import {
    createProject, duplicateProject, library, openAsNew, openProject, removeProject, removeVersion, renameProject, restoreVersion, saveVersion,
  } from '../projects.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  // someone with only the one beat is most likely here for a demo; someone with a library, for their own
  let view = $state<'mine' | 'demos'>(library.list.length > 1 ? 'mine' : 'demos');
  let renaming = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let label = $state('');

  // most recently worked on first, with the one that is open at the top
  const beats = $derived([...library.list].sort((a, b) => (b.id === library.current ? 1 : 0) - (a.id === library.current ? 1 : 0) || b.updated - a.updated));

  function demo(i: number): void {
    app.modal = null;
    void openAsNew(DEMOS[i].make()).then(() => play());
  }
  async function open(id: string): Promise<void> {
    if (await openProject(id)) app.modal = null;
  }
  function fresh(): void {
    app.modal = null;
    void createProject();
  }
  function rename(e: Event, id: string): void {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).elements.namedItem('name') as HTMLInputElement;
    void renameProject(id, input.value);
    renaming = null;
  }
  function keep(e: Event): void {
    e.preventDefault();
    void saveVersion(label).then((ok) => { if (ok) label = ''; });
  }
  const focus = (node: HTMLInputElement) => { node.focus(); node.select(); };

  function when(t: number): string {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
    return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: mins > 60 * 24 * 300 ? 'numeric' : undefined });
  }
</script>

<Modal title="Beats" wide>
  <div class="top">
    <div class="seg" role="radiogroup" aria-label="Which beats">
      <button class:on={view === 'mine'} role="radio" aria-checked={view === 'mine'} onclick={() => (view = 'mine')}>My beats</button>
      <button class:on={view === 'demos'} role="radio" aria-checked={view === 'demos'} onclick={() => (view = 'demos')}>Demos</button>
    </div>
    <button class="btn new" onclick={fresh}><Icon name="plus" />New beat</button>
  </div>

  {#if view === 'demos'}
    <p>Open a demo, pull it apart, make it yours. It opens as a new beat, so the one you were working on stays in My beats.</p>
    <div class="list">
      {#each DEMOS as d, i}
        <button onclick={() => demo(i)} style:--c="var(--t{[0, 2, 4, 7][i % 4]})">
          <i><Icon name="play" size={16} fill /></i>
          <span><b>{d.name}</b><small>{d.blurb}</small></span>
        </button>
      {/each}
    </div>
  {:else if !library.available}
    <p class="warn">This browser isn't keeping a library (private windows don't). The beat you are working on still saves itself; use Export → Save project to keep others.</p>
  {:else}
    <p>Everything you make saves itself here as you work, on this device only.</p>
    <ul class="beats">
      {#each beats as b (b.id)}
        {@const current = b.id === library.current}
        <li class:current>
          {#if renaming === b.id}
            <form onsubmit={(e) => rename(e, b.id)}>
              <input name="name" value={b.name} maxlength="40" aria-label="New name for {b.name}" spellcheck="false" use:focus
                onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); renaming = null; } }} />
              <button class="btn">Rename</button>
            </form>
          {:else if confirming === b.id}
            <span class="ask">Delete “{b.name}” and its versions for good?</span>
            <button class="btn danger" onclick={() => { confirming = null; void removeProject(b.id); }}>Delete</button>
            <button class="btn" onclick={() => (confirming = null)}>Keep</button>
          {:else}
            <button class="open" onclick={() => open(b.id)} disabled={current} aria-label="{current ? 'Open now' : 'Open'}: {b.name}">
              <b>{b.name}</b>
              <small>{current ? 'Open now' : when(b.updated)} · {b.bpm} bpm · {b.tracks} track{b.tracks === 1 ? '' : 's'}</small>
            </button>
            <button class="btn ghost sq" onclick={() => (renaming = b.id)} aria-label="Rename {b.name}" title="Rename"><Icon name="edit" size={14} /></button>
            <button class="btn ghost sq" onclick={() => duplicateProject(b.id)} aria-label="Duplicate {b.name}" title="Duplicate"><Icon name="copy" size={14} /></button>
            <button class="btn ghost sq" onclick={() => (confirming = b.id)} aria-label="Delete {b.name}" title="Delete"><Icon name="trash" size={14} /></button>
          {/if}
        </li>
      {:else}
        <li class="none">Your beats will appear here.</li>
      {/each}
    </ul>

    <h3>Versions of “{app.project.name}”</h3>
    <form class="keep" onsubmit={keep}>
      <input bind:value={label} maxlength="40" placeholder="Name this version (optional)" aria-label="Name for the version" spellcheck="false" />
      <button class="btn">Save a version</button>
    </form>
    {#if library.versions.length}
      <ul class="versions">
        {#each library.versions as v (v.id)}
          <li>
            <span class="vl">{v.label}</span>
            <small>{v.auto ? 'automatic · ' : ''}{when(v.time)}</small>
            <button class="btn" onclick={() => { app.modal = null; void restoreVersion(v.id); }} title="Go back to this version. The beat as it is now stays in undo.">Restore</button>
            <button class="btn ghost sq" onclick={() => removeVersion(v.id)} aria-label="Delete the version {v.label}"><Icon name="trash" size={13} /></button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="small">A version is the beat exactly as it is now, kept so you can come back to it. One is also saved automatically every ten minutes while you work.</p>
    {/if}
  {/if}
</Modal>

<style>
  .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .new { height: 32px; gap: 6px; }
  p { margin: 6px 0 12px; font-size: 13px; line-height: 1.45; color: var(--dim); }
  .small { font-size: 12px; }
  .warn { color: var(--ink); }
  h3 { margin: 18px 0 8px; font: 700 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .list button {
    display: flex; align-items: center; gap: 12px; text-align: left; padding: 12px;
    border-radius: 14px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 3px 0 var(--edge), inset 0 1px 0 var(--hi);
    transition: transform 60ms, box-shadow 60ms;
  }
  .list button:active { transform: translateY(3px); box-shadow: none; }
  .list i { flex: none; width: 40px; height: 40px; border-radius: 12px; background: var(--c); color: #fff; display: grid; place-items: center; }
  .list span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .list b { font-size: 15px; }
  .list small { font-size: 12px; color: var(--dim); }
  ul { list-style: none; margin: 0; padding: 4px; border-radius: 12px; background: var(--inset); display: flex; flex-direction: column; gap: 2px; }
  .beats { max-height: 34vh; overflow-y: auto; scrollbar-width: thin; }
  li { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 2px 4px 2px 0; border-radius: 9px; }
  li.current { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  li.none { padding: 12px; font-size: 13px; color: var(--dim); }
  .open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; }
  .open:not(:disabled):hover { background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .open b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .open small, .versions small { font: 600 10px var(--mono); color: var(--dim); }
  .open:disabled { cursor: default; color: inherit; opacity: 1; }
  li form, .keep { flex: 1; display: flex; gap: 6px; padding-left: 6px; }
  .keep { padding: 0; margin-bottom: 8px; }
  input {
    flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  li input { background: var(--panel); }
  li .btn, .keep .btn { height: 32px; font-size: 11px; }
  li .btn.sq { width: 30px; }
  .ask { flex: 1; padding-left: 10px; font-size: 13px; }
  .danger { background: var(--rec); color: #fff; border-color: transparent; }
  .versions li { min-height: 36px; padding-left: 10px; gap: 8px; }
  .versions .btn { height: 26px; font-size: 10px; }
  .vl { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 480px) { .list { grid-template-columns: 1fr; } }
</style>
