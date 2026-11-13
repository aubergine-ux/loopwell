<script lang="ts">
  import { jumpTo, redo, undo } from '../actions.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  // newest first, the way a list of "what I just did" reads
  const steps = $derived(app.history.map((h, i) => ({ ...h, i })).reverse());
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const say = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
</script>

<Modal title="History">
  <p>Every change since you opened Loopwell. Pick one to go back to how the beat was right after it.</p>
  <div class="row">
    <button class="btn" onclick={undo} disabled={!app.canUndo}><Icon name="undo" size={14} />Undo</button>
    <button class="btn" onclick={redo} disabled={!app.canRedo}><Icon name="redo" size={14} />Redo</button>
    <span>{app.historyAt + 1} of {app.history.length}</span>
  </div>
  <ol>
    {#each steps as s (s.i)}
      <li>
        <button class:on={s.i === app.historyAt} class:undone={s.i > app.historyAt} onclick={() => jumpTo(s.i)}
          aria-current={s.i === app.historyAt ? 'step' : undefined} aria-label="{say(s.label)}, at {time(s.time)}{s.i > app.historyAt ? ', undone' : ''}">
          <i></i><span>{say(s.label)}</span><time>{time(s.time)}</time>
        </button>
      </li>
    {/each}
  </ol>
</Modal>

<style>
  p { margin: 4px 0 12px; font-size: 13px; line-height: 1.45; color: var(--dim); }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .row .btn { height: 30px; gap: 6px; font-size: 11px; }
  .row span { margin-left: auto; font: 600 11px var(--mono); color: var(--dim); }
  ol { list-style: none; margin: 0; padding: 4px; border-radius: 12px; background: var(--inset); max-height: 46vh; overflow-y: auto; scrollbar-width: thin; }
  li button {
    width: 100%; display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 4px 10px; border: 0; border-radius: 8px; background: none;
    text-align: left; font-size: 13px;
  }
  li button:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); }
  li button.on { background: var(--ink); color: var(--panel); }
  li button.undone { opacity: 0.45; }
  i { flex: none; width: 8px; height: 8px; border-radius: 50%; border: 2px solid currentColor; }
  .on i { background: var(--accent); border-color: var(--accent); }
  li span { flex: 1; min-width: 0; }
  time { font: 600 10px var(--mono); opacity: 0.6; }
</style>
