<script lang="ts">
  import { clearPattern, copyPattern } from '../actions.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  const p = $derived(app.project);
  const MAX_SONG = 64;
  let copyTo = $state(1);

  const hasNotes = (i: number) =>
    p.patterns[i].steps.some((r) => r.some((v) => v > 0)) || p.patterns[i].notes.some((n) => n.length > 0);
  const bars = $derived((p.song.length * p.steps) / 16);
  const seconds = $derived((p.song.length * p.steps * 60) / p.bpm / 4);
</script>

<div class="song">
  <div class="left">
    <div class="row">
      <span class="label">Song</span>
      <div class="seg">
        <button class:on={!p.songMode} onclick={() => (p.songMode = false)}>Loop pattern</button>
        <button class:on={p.songMode} onclick={() => (p.songMode = true)}>Play song</button>
      </div>
      <span class="len">{bars} bar{bars === 1 ? '' : 's'} · {Math.floor(seconds / 60)}:{String(Math.round(seconds % 60)).padStart(2, '0')}</span>
    </div>
    <div class="chain">
      {#each p.song as s, i}
        <button class="slot" class:now={app.playing && p.songMode && app.songPos === i} class:empty={!hasNotes(s)}
          onclick={() => { if (p.song.length > 1) p.song.splice(i, 1); }} title="Click to remove from the song" aria-label="Remove pattern {'ABCD'[s]} at position {i + 1}">
          <small>{i + 1}</small>{'ABCD'[s]}
        </button>
      {/each}
      {#if p.song.length < MAX_SONG}<span class="cursor"></span>{/if}
    </div>
    <div class="row">
      <span class="label">Add</span>
      {#each 'ABCD' as name, i}
        <button class="btn sq" disabled={p.song.length >= MAX_SONG} onclick={() => p.song.push(i)} aria-label="Add pattern {name} to the song">{name}</button>
      {/each}
      <button class="btn ghost" onclick={() => (p.song = [app.pat])}>Reset</button>
    </div>
  </div>
  <div class="right">
    <span class="label">Pattern {'ABCD'[app.pat]}</span>
    <div class="row">
      <button class="btn" onclick={() => copyPattern(app.pat, copyTo)} disabled={copyTo === app.pat}><Icon name="copy" size={13} />Copy to</button>
      <div class="seg">
        {#each 'ABCD' as name, i}
          <button class:on={copyTo === i} disabled={i === app.pat} onclick={() => (copyTo = i)}>{name}</button>
        {/each}
      </div>
    </div>
    <button class="btn" onclick={() => clearPattern()}><Icon name="trash" size={13} />Clear pattern</button>
    <p>Build up to four patterns, then chain them here. While a pattern is looping, tapping another one switches on the next bar.</p>
  </div>
</div>

<style>
  .song { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 22px; }
  .left, .right { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; min-width: 0; }
  .right { padding-left: 22px; border-left: 1px solid var(--line); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .len { font: 600 11px var(--mono); color: var(--dim); }
  .chain {
    display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; width: 100%; min-height: 96px; max-height: 150px; overflow-y: auto;
    padding: 10px; border-radius: 12px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.14);
  }
  .slot {
    position: relative; width: 44px; height: 44px; border-radius: 10px; border: 0;
    background: var(--ink); color: var(--panel); font: 700 16px var(--mono);
    box-shadow: 0 3px 0 rgb(0 0 0 / 0.35);
  }
  .slot.empty { opacity: 0.5; }
  .slot small { position: absolute; top: 3px; left: 5px; font-size: 8px; opacity: 0.6; }
  .slot.now { background: var(--accent); color: var(--accent-ink); }
  .slot:hover { filter: brightness(1.2); }
  .cursor { width: 3px; height: 44px; border-radius: 2px; background: var(--accent); animation: caret 1s steps(2, jump-none) infinite; }
  @keyframes caret { 50% { opacity: 0; } }
  p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--dim); }
  .seg button:disabled { opacity: 0.35; }
  @media (max-width: 900px) { .song { grid-template-columns: 1fr; } .right { padding-left: 0; border-left: 0; } }
</style>
