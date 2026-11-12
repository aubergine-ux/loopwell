<script lang="ts">
  import { loadProject, newBeat, play } from '../actions.svelte';
  import { DEMOS } from '../core/demos';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  function open(i: number): void {
    loadProject(DEMOS[i].make());
    app.modal = null;
    void play();
  }
</script>

<Modal title="Beats">
  <p>Open a demo, pull it apart, make it yours. Your current beat stays in undo.</p>
  <div class="list">
    {#each DEMOS as d, i}
      <button onclick={() => open(i)} style:--c="var(--t{[0, 2, 4, 7][i % 4]})">
        <i><Icon name="play" size={16} fill /></i>
        <span><b>{d.name}</b><small>{d.blurb}</small></span>
      </button>
    {/each}
  </div>
  <button class="btn new" onclick={() => { newBeat(); app.modal = null; }}><Icon name="plus" />New beat</button>
</Modal>

<style>
  p { margin: 6px 0 14px; font-size: 14px; }
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
  .new { margin-top: 16px; height: 40px; width: 100%; }
  @media (max-width: 480px) { .list { grid-template-columns: 1fr; } }
</style>
