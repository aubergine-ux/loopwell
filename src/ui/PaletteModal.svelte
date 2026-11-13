<script lang="ts">
  import { tick } from 'svelte';
  import { keyLabel, keysFor, search, type Command } from '../commands.svelte';
  import { app } from '../state.svelte';

  // Ctrl/Cmd+K: type a few letters of anything (an action, a sound, a setting, a beat) and press Enter.
  let query = $state('');
  let at = $state(0);
  let list = $state<HTMLElement>();
  const results = $derived(search(query));
  $effect(() => { void query; at = 0; });

  function run(c: Command): void {
    app.modal = null;
    c.run();
  }
  function key(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      at = (at + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % Math.max(1, results.length);
      void tick().then(() => list?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') { if (results[at]) run(results[at]); } else return;
    e.preventDefault();
  }
  const focus = (node: HTMLElement) => node.focus();
</script>

<div class="back" onpointerdown={(e) => { if (e.target === e.currentTarget) app.modal = null; }} role="presentation">
  <div class="palette" role="dialog" aria-modal="true" aria-label="Find anything">
    <input bind:value={query} onkeydown={key} use:focus type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
      aria-activedescendant={results[at] ? `palette-${at}` : undefined} placeholder="Find an action, a sound, a setting, a beat…" spellcheck="false" autocomplete="off" />
    <div class="list" id="palette-list" role="listbox" aria-label="Results" bind:this={list}>
      {#each results as c, i (c.id)}
        <button id="palette-{i}" class:on={i === at} role="option" aria-selected={i === at} tabindex="-1" onclick={() => run(c)} onpointermove={() => (at = i)}>
          <small>{c.group}</small>
          <span>{c.title}</span>
          {#if 'keys' in c || keysFor(c)}<kbd>{keyLabel(keysFor(c))}</kbd>{/if}
        </button>
      {:else}
        <p>Nothing matches “{query}”.</p>
      {/each}
    </div>
    <footer><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to do it</span><span><kbd>Esc</kbd> to close</span></footer>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 55; display: flex; justify-content: center; align-items: flex-start; padding: 12vh 16px 16px; background: rgb(0 0 0 / 0.45); backdrop-filter: blur(4px); }
  .palette {
    width: min(600px, 100%); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
    background: var(--panel); border-radius: 18px; border: 1px solid var(--line); box-shadow: 0 40px 80px -20px rgb(0 0 0 / 0.6);
  }
  input {
    height: 52px; padding: 0 18px; border: 0; border-bottom: 1px solid var(--line); background: none; outline: none;
    font: 600 16px var(--sans, inherit); user-select: text; -webkit-user-select: text;
  }
  .list { overflow-y: auto; padding: 6px; scrollbar-width: thin; }
  .list button {
    width: 100%; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border: 0; border-radius: 9px; background: none; text-align: left;
    font-size: 13.5px;
  }
  .list button.on { background: var(--ink); color: var(--panel); }
  small { flex: 0 0 76px; font: 700 9px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.6; }
  .list span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { font: 600 10px var(--mono); padding: 1px 6px; border-radius: 5px; border: 1px solid currentColor; opacity: 0.7; white-space: nowrap; }
  kbd:empty { display: none; }
  p { margin: 0; padding: 18px 12px; font-size: 13px; color: var(--dim); }
  footer { display: flex; gap: 16px; padding: 8px 16px; border-top: 1px solid var(--line); font: 600 10px var(--mono); color: var(--dim); }
  footer kbd { margin-right: 3px; }
  @media (max-width: 520px) { small { display: none; } footer { display: none; } .back { padding-top: 8vh; } }
</style>
