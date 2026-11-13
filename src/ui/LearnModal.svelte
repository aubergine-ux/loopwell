<script lang="ts">
  import { CHALLENGES, PASS } from '../core/learn';
  import { LESSONS, learn, startChallenge, startLesson } from '../learn.svelte';
  import { prefs } from '../prefs.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let busy = $state('');
  async function go(id: string, what: (id: string) => Promise<void>): Promise<void> {
    if (busy) return;
    busy = id;
    try { await what(id); } finally { busy = ''; }
  }
  const done = (id: string) => (id === 'first' ? prefs.toured : learn.lessons.includes(id));
  const LEVELS = ['', 'Easy', 'Medium', 'By ear'];
</script>

<Modal title="Learn" wide>
  <p class="lead">Each one opens a new beat to work on. The beat you have open now is saved under Beats, as always.</p>

  <h3>Lessons <small>{LESSONS.filter((l) => done(l.id)).length} of {LESSONS.length} done</small></h3>
  <div class="list">
    {#each LESSONS as l (l.id)}
      <button onclick={() => go(l.id, startLesson)} disabled={!!busy} class:done={done(l.id)}>
        <span class="mark">{#if done(l.id)}<Icon name="check" size={16} />{:else}<Icon name="play" size={14} />{/if}</span>
        <span class="text"><b>{l.name}</b><small>{l.blurb}</small></span>
        <span class="meta">{busy === l.id ? 'Opening…' : `${l.minutes} min`}</span>
      </button>
    {/each}
  </div>

  <h3>Recreate this beat <small>{CHALLENGES.filter((c) => (learn.best[c.id] ?? 0) >= PASS).length} of {CHALLENGES.length} matched</small></h3>
  <p class="small">You hear a beat and build it yourself. A meter shows how close you are as you go, track by track.</p>
  <div class="list">
    {#each CHALLENGES as c (c.id)}
      {@const best = learn.best[c.id] ?? 0}
      <button onclick={() => go(c.id, startChallenge)} disabled={!!busy} class:done={best >= PASS}>
        <span class="mark">{#if best >= PASS}<Icon name="check" size={16} />{:else}<Icon name="note" size={14} />{/if}</span>
        <span class="text"><b>{c.name}</b><small>{c.blurb}</small></span>
        <span class="meta">{busy === c.id ? 'Opening…' : best ? `Best ${Math.round(best * 100)}%` : LEVELS[c.level]}</span>
      </button>
    {/each}
  </div>
</Modal>

<style>
  .lead, .small { margin: 0 0 10px; font-size: 13px; line-height: 1.45; color: var(--dim); }
  h3 { margin: 16px 0 8px; font: 600 10px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); display: flex; gap: 10px; align-items: baseline; }
  h3 small { font-size: 10px; letter-spacing: 0.04em; text-transform: none; opacity: 0.8; }
  .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 8px; }
  .list button {
    display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 12px; align-items: center; text-align: left; padding: 12px;
    border-radius: 12px; border: 1px solid var(--line); background: var(--raise); box-shadow: 0 2px 0 var(--edge);
  }
  .list button:hover { border-color: var(--accent); }
  .list button:active { transform: translateY(2px); box-shadow: none; }
  .list button:disabled { opacity: 0.6; }
  .mark { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--inset); color: var(--dim); }
  .done .mark { background: var(--t3); color: var(--on-c); }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .text b { font-size: 14px; }
  .text small { font-size: 12px; line-height: 1.35; color: var(--dim); }
  .meta { font: 600 10px var(--mono); color: var(--dim); white-space: nowrap; }
</style>
