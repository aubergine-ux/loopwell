<script lang="ts">
  import { clearPattern, copyPattern, setView } from '../actions.svelte';
  import { songEnd, stepToSeconds } from '../core/arrange';
  import { PATTERN_NAMES } from '../core/types';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  const p = $derived(app.project);
  let copyTo = $state(1);

  const hasNotes = (i: number) =>
    p.patterns[i].steps.some((r) => r.some((v) => v > 0)) || p.patterns[i].notes.some((n) => n.length > 0);
  const uses = (i: number) => p.arr.clips.filter((c) => c.pattern === i).length;
  const end = $derived(songEnd(p.arr));
  const seconds = $derived(Math.round(stepToSeconds(p, end)));
</script>

<div class="song">
  <div class="left">
    <div class="row">
      <span class="label">Patterns</span>
      <span class="len">{p.arr.clips.length} clip{p.arr.clips.length === 1 ? '' : 's'} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
    </div>
    <div class="chain">
      {#each PATTERN_NAMES as name, i}
        <button class="slot" class:now={app.pat === i} class:empty={!hasNotes(i)} onclick={() => (app.pat = i)}
          aria-label="Pattern {name}, used by {uses(i)} clips" title="Show pattern {name}">
          {name}<small>{uses(i) ? `×${uses(i)}` : ''}</small>
        </button>
      {/each}
    </div>
    <div class="row">
      <button class="btn" class:on={p.songMode} onclick={() => setView(!p.songMode)}>
        {p.songMode ? 'Back to the pattern' : 'Open the timeline'}
      </button>
    </div>
  </div>
  <div class="right">
    <span class="label">Pattern {PATTERN_NAMES[app.pat]}</span>
    <div class="row">
      <button class="btn" onclick={() => copyPattern(app.pat, copyTo)} disabled={copyTo === app.pat}><Icon name="copy" size={13} />Copy to</button>
      <div class="seg">
        {#each PATTERN_NAMES as name, i}
          <button class:on={copyTo === i} disabled={i === app.pat} onclick={() => (copyTo = i)}>{name}</button>
        {/each}
      </div>
    </div>
    <button class="btn" onclick={() => clearPattern()}><Icon name="trash" size={13} />Clear pattern</button>
    <p>Build loops in the pattern view, then place them as clips on the timeline. Every track can play a different pattern at the same time.</p>
  </div>
</div>

<style>
  .song { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 380px); gap: 22px; }
  .left, .right { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; min-width: 0; }
  .right { padding-left: 22px; border-left: 1px solid var(--line); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .len { font: 600 11px var(--mono); color: var(--dim); }
  .chain {
    display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; width: 100%;
    padding: 10px; border-radius: 12px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.14);
  }
  .slot {
    position: relative; width: 48px; height: 48px; border-radius: 10px; border: 0;
    background: var(--ink); color: var(--panel); font: 700 16px var(--mono);
    box-shadow: 0 3px 0 rgb(0 0 0 / 0.35);
  }
  .slot.empty { opacity: 0.5; }
  .slot small { position: absolute; bottom: 3px; right: 5px; font-size: 8px; opacity: 0.7; }
  .slot.now { background: var(--accent); color: var(--accent-ink); }
  .slot:hover { filter: brightness(1.2); }
  p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--dim); }
  .seg button { min-width: 26px; padding: 0 6px; }
  .seg button:disabled { opacity: 0.35; }
  @media (max-width: 900px) { .song { grid-template-columns: 1fr; } .right { padding-left: 0; border-left: 0; } }
</style>
