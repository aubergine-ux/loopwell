<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { addToLibrary, addTrack, forgetSample, toast, useSample } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { waveformPeaks } from '../core/analyze';
  import { MAX_TRACKS } from '../core/types';
  import {
    CATEGORIES, addTag, analyze, analyzeLoaded, entries, forgetEntry, foundTags, isFav, library, matches, removeTag, toggleFav, type Entry,
  } from '../library.svelte';
  import { app } from '../state.svelte';
  import { dragSound, dragSoundEnd } from './dragsound';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  let query = $state('');
  let filter = $state('all');
  let current = $state(app.project.tracks[app.sel].sample);
  let autoplay = $state(true);
  let tag = $state('');
  let loaded = $state(0);
  let canvas = $state<HTMLCanvasElement>();
  let list = $state<HTMLElement>();
  let picker = $state<HTMLInputElement>();

  const all = $derived(entries());
  const shown = $derived(all.filter((e) =>
    (filter === 'all' || (filter === 'fav' ? isFav(e.id) : filter === 'mine' ? !e.builtin : e.auto.includes(filter))) && matches(e, query)));
  const entry = $derived(all.find((e) => e.id === current) ?? null);
  const info = $derived(entry ? library.info[entry.id] : undefined);
  const inUse = $derived(entry ? p.tracks.filter((x) => x.sample === entry.id && (x.kind === 'drum' || x.kind === 'slice')).length : 0);

  function select(e: Entry, play = autoplay): void {
    current = e.id;
    if (play) void audio.resume().then(() => audio.preview(e.id));
    void analyze(e.id).then(() => loaded++);
  }

  function key(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== ' ') return;
    if ((e.target as HTMLElement).closest('.side')) return;
    const i = shown.findIndex((x) => x.id === current);
    if (e.key === 'Enter') { if (entry && (e.target as HTMLElement).tagName !== 'INPUT') use(); else if (shown.length) select(shown[Math.max(0, i)]); }
    else if (e.key === ' ') { if ((e.target as HTMLElement).tagName === 'INPUT') return; if (entry) select(entry, true); }
    else {
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { select(next); void tick().then(() => list?.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' })); }
    }
    e.preventDefault();
  }

  function use(): void {
    if (!entry) return;
    useSample(app.sel, entry.id);
    app.modal = null;
  }
  function useNew(): void {
    if (!entry) return;
    addTrack('drum');
    useSample(app.sel, entry.id);
    app.modal = null;
  }
  function remove(): void {
    if (!entry || entry.builtin) return;
    const i = shown.findIndex((x) => x.id === entry.id);
    const next = shown[i + 1] ?? shown[i - 1];
    const id = entry.id;
    void audio.preview('');
    current = next?.id ?? '';
    forgetSample(id);
    forgetEntry(id);
  }
  async function pick(e: Event): Promise<void> {
    const el = e.currentTarget as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    let last = '', added = 0;
    for (const f of files) {
      const id = await addToLibrary(f);
      if (id) { last = id; added++; }
    }
    if (!last) return;
    filter = 'mine';
    query = '';
    current = last;
    void analyze(last).then(() => loaded++);
    // when a file was refused, the message saying why stays up instead
    if (added > 1 && added === files.length) toast(`${added} sounds added to your library`);
  }
  function submitTag(e: Event): void {
    e.preventDefault();
    if (entry && addTag(entry.id, tag)) tag = '';
  }

  const length = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);

  function draw(): void {
    const c = canvas;
    if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).getPropertyValue('--c').trim() || '#888';
    const data = current ? audio.bank[current] : undefined;
    if (!data) { g.globalAlpha = 0.4; g.fillRect(0, h / 2, w, 1); return; }
    const pk = waveformPeaks(data.l, w);
    for (let x = 0; x < w; x++) {
      const y0 = h / 2 - pk[x * 2 + 1] * (h / 2 - 1), y1 = h / 2 - pk[x * 2] * (h / 2 - 1);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  $effect(() => { void current; void loaded; void app.theme; draw(); });

  onMount(() => {
    void analyzeLoaded();
    if (entry) void analyze(entry.id).then(() => loaded++);
    void tick().then(() => list?.querySelector('.row.on')?.scrollIntoView({ block: 'center' }));
    return () => void audio.preview('');
  });
</script>

<Modal title="Sounds" wide>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="browser" style:--c="var(--t{t.color})" onkeydown={key}>
    <div class="main">
      <!-- svelte-ignore a11y_autofocus -->
      <input class="search" type="search" bind:value={query} placeholder="Search by name, kit or tag: “hat”, “dust”, “120 bpm”, “a minor”…" aria-label="Search sounds"
        spellcheck="false" autofocus />
      <div class="filters" role="group" aria-label="Show">
        <button class:on={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
        <button class:on={filter === 'fav'} onclick={() => (filter = 'fav')}>★ Favourites</button>
        <button class:on={filter === 'mine'} onclick={() => (filter = 'mine')}>Imported</button>
        {#each CATEGORIES as c}<button class:on={filter === c} onclick={() => (filter = c)}>{c}</button>{/each}
      </div>
      <div class="list" bind:this={list} role="listbox" aria-label="Sounds" tabindex="0">
        {#each shown as e (e.id)}
          <div class="row" class:on={current === e.id} role="option" tabindex="-1" aria-selected={current === e.id} draggable="true"
            ondragstart={(ev) => dragSound(ev, e.id)} ondragend={dragSoundEnd}>
            <button class="star" class:on={isFav(e.id)} onclick={() => toggleFav(e.id)} aria-pressed={isFav(e.id)}
              aria-label="{isFav(e.id) ? 'Remove' : 'Add'} {e.name} {isFav(e.id) ? 'from' : 'to'} favourites">★</button>
            <button class="pick" onclick={() => select(e)} ondblclick={use} title="Click to hear it, double-click to use it, or drag it onto a track">
              <b>{e.name}</b>
              <span class="src">{e.source}</span>
              <span class="tags">{[...foundTags(e.id), ...(library.tags[e.id] ?? [])].join(' · ')}</span>
            </button>
          </div>
        {:else}
          <p class="empty">
            {#if filter === 'mine' && !query}Nothing imported yet. Add your own sounds with <b>Import</b>, or drop audio files anywhere on Loopwell.
            {:else if filter === 'fav' && !query}No favourites yet. Press the star next to a sound to keep it here.
            {:else}No sound matches “{query}”{filter === 'all' ? '' : ' here'}.{/if}
          </p>
        {/each}
      </div>
      <div class="foot">
        <span>{shown.length} of {all.length} sounds</span>
        <label><input type="checkbox" bind:checked={autoplay} /> Play when selected</label>
        <button class="btn" onclick={() => (app.modal = 'stems')} title="Split a song or loop into drums, bass, vocals and the rest"><Icon name="wave" size={13} />Stems…</button>
        <button class="btn" onclick={() => picker?.click()}><Icon name="open" size={13} />Import…</button>
        <input bind:this={picker} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.aif,.m4a" multiple hidden onchange={pick} />
      </div>
    </div>

    <div class="side">
      {#if entry}
        <div class="head">
          <b>{entry.name}</b>
          <span>{entry.source}</span>
        </div>
        <button class="wave" onclick={() => select(entry, true)} aria-label="Play {entry.name}" title="Play"><canvas bind:this={canvas}></canvas></button>
        <dl>
          <div><dt>Length</dt><dd>{info ? length(info.seconds) : '…'}</dd></div>
          <div><dt>Tempo</dt><dd>{info ? (info.bpm ? `${info.bpm} bpm` : '—') : '…'}</dd></div>
          <div><dt>Key</dt><dd>{info ? info.key ?? '—' : '…'}</dd></div>
        </dl>
        <div class="taglist">
          {#each entry.auto as x}<span class="tag">{x}</span>{/each}
          {#each foundTags(entry.id) as x}<span class="tag found" title="Found by listening to the sound">{x}</span>{/each}
          {#each library.tags[entry.id] ?? [] as x}
            <span class="tag mine">{x}<button onclick={() => removeTag(entry.id, x)} aria-label="Remove tag {x}">×</button></span>
          {/each}
        </div>
        <form class="addtag" onsubmit={submitTag}>
          <input bind:value={tag} maxlength="20" placeholder="Add a tag" aria-label="Add a tag to {entry.name}" spellcheck="false" />
          <button class="btn" disabled={!tag.trim()}>Add</button>
        </form>
        <div class="actions">
          <button class="btn on" onclick={use}>Use on {t.name}</button>
          <button class="btn" onclick={useNew} disabled={p.tracks.length >= MAX_TRACKS}
            title={p.tracks.length >= MAX_TRACKS ? 'All 8 tracks are in use' : 'Add a track that plays this sound'}><Icon name="plus" size={13} />New track</button>
          {#if !entry.builtin}
            <button class="btn ghost sq" onclick={remove} aria-label="Remove {entry.name} from the library"
              title={inUse ? `Used by ${inUse} track${inUse > 1 ? 's' : ''}, which will fall silent` : 'Remove from the library'}><Icon name="trash" size={14} /></button>
          {/if}
        </div>
      {:else}
        <p class="empty">Pick a sound to hear it and see what it is.</p>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .browser { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 16px; }
  .main, .side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .search, .addtag input {
    height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text; min-width: 0;
  }
  .search:focus, .addtag input:focus { border-color: var(--c); outline: none; }
  .filters { display: flex; flex-wrap: wrap; gap: 4px; }
  .filters button {
    height: 22px; padding: 0 8px; border-radius: 11px; border: 1px solid var(--line); background: transparent; color: var(--dim);
    font: 600 10px var(--mono); text-transform: capitalize;
  }
  .filters button.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .list {
    height: min(46vh, 380px); overflow-y: auto; border-radius: 10px; background: var(--inset); padding: 4px;
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.14); scrollbar-width: thin; outline: none;
  }
  .list:focus-visible { box-shadow: inset 0 0 0 2px var(--c); }
  .row { display: flex; align-items: center; border-radius: 7px; }
  .row.on { background: var(--c); color: var(--on-c); }
  .star { flex: none; width: 28px; height: 30px; border: 0; background: none; color: var(--dim); opacity: 0.45; font-size: 14px; }
  .star.on { opacity: 1; color: var(--t2); }
  .row.on .star { color: var(--on-c); }
  .pick {
    flex: 1; min-width: 0; height: 30px; display: flex; align-items: baseline; gap: 8px; padding: 0 8px 0 0; border: 0; background: none;
    color: inherit; text-align: left; font: 600 12px var(--mono);
  }
  .pick b { text-transform: capitalize; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pick .src { font-size: 10px; opacity: 0.65; white-space: nowrap; }
  .pick .tags { margin-left: auto; font-size: 10px; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { margin: 0; padding: 18px 12px; font-size: 13px; line-height: 1.45; color: var(--dim); }
  .foot { display: flex; align-items: center; gap: 12px; font: 600 11px var(--mono); color: var(--dim); }
  .foot label { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; }
  .foot .btn { height: 28px; font-size: 11px; gap: 5px; }
  .head { display: flex; flex-direction: column; gap: 1px; }
  .head b { font-size: 17px; text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head span { font: 600 11px var(--mono); color: var(--dim); }
  .wave { height: 86px; padding: 0; border: 0; border-radius: 10px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.14); cursor: pointer; }
  .wave canvas { width: 100%; height: 100%; display: block; }
  dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 0; }
  dl div { padding: 6px 8px; border-radius: 8px; background: var(--inset); min-width: 0; }
  dt { font: 700 8.5px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  dd { margin: 2px 0 0; font: 700 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .taglist { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag {
    display: inline-flex; align-items: center; gap: 3px; height: 20px; padding: 0 7px; border-radius: 10px; background: var(--inset);
    font: 600 10px var(--mono); color: var(--dim);
  }
  .tag.found { color: var(--ink); border: 1px dashed var(--line); background: none; }
  .tag.mine { background: var(--ink); color: var(--panel); }
  .tag button { border: 0; padding: 0; background: none; color: inherit; font: inherit; opacity: 0.7; }
  .addtag { display: flex; gap: 6px; }
  .addtag input { flex: 1; height: 28px; }
  .addtag .btn { height: 28px; font-size: 11px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
  .actions .btn { height: 32px; font-size: 11px; gap: 5px; }
  @media (max-width: 640px) {
    .browser { grid-template-columns: minmax(0, 1fr); }
    .list { height: 34vh; }
    .wave { height: 60px; }
  }
</style>
