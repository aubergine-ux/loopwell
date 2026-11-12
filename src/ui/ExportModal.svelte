<script lang="ts">
  import { exportMidiFile, exportStems, exportWav, handleFiles, saveProjectFile } from '../actions.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let picker: HTMLInputElement;
  const p = $derived(app.project);
  const what = $derived(p.songMode
    ? `the song (${p.song.map((s) => 'ABCD'[s]).join(' ')})`
    : `pattern ${'ABCD'[app.pat]}, once through. Turn on Song mode to export the whole chain`);

  function run(fn: () => void | Promise<void>): void {
    app.modal = null;
    void fn();
  }
  function open(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) { app.modal = null; void handleFiles([...input.files]); }
    input.value = '';
  }
</script>

<Modal title="Export">
  <p>Exports {what}.</p>
  <div class="list">
    <button onclick={() => run(exportWav)}>
      <Icon name="wave" size={22} />
      <span><b>WAV</b><small>The full mix with effects, 24-bit stereo</small></span>
    </button>
    <button onclick={() => run(exportStems)}>
      <Icon name="grid" size={22} />
      <span><b>Stems</b><small>One WAV per track in a zip, for mixing in a DAW</small></span>
    </button>
    <button onclick={() => run(exportMidiFile)}>
      <Icon name="note" size={22} />
      <span><b>MIDI</b><small>Notes and drum hits as a standard .mid file</small></span>
    </button>
  </div>
  <h3>Project file</h3>
  <p class="small">A .loopwell file holds the whole project, including any samples you loaded yourself.</p>
  <div class="list two">
    <button onclick={() => run(saveProjectFile)}>
      <Icon name="file" size={22} />
      <span><b>Save project</b><small>Download a .loopwell file</small></span>
    </button>
    <button onclick={() => picker.click()}>
      <Icon name="open" size={22} />
      <span><b>Open project</b><small>Load a .loopwell file</small></span>
    </button>
  </div>
  <input bind:this={picker} type="file" accept=".loopwell,.zip" hidden onchange={open} />
</Modal>

<style>
  p { margin: 6px 0 12px; font-size: 14px; line-height: 1.45; }
  .small { font-size: 13px; color: var(--dim); }
  h3 { margin: 18px 0 0; font: 700 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .list { display: grid; gap: 8px; }
  .list.two { grid-template-columns: 1fr 1fr; }
  .list button {
    display: flex; align-items: center; gap: 14px; text-align: left; padding: 12px 14px;
    border-radius: 14px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 3px 0 var(--edge), inset 0 1px 0 var(--hi);
    transition: transform 60ms, box-shadow 60ms;
  }
  .list button:active { transform: translateY(3px); box-shadow: none; }
  .list span { display: flex; flex-direction: column; gap: 2px; }
  .list b { font-size: 15px; }
  .list small { font-size: 12px; color: var(--dim); }
  @media (max-width: 480px) { .list.two { grid-template-columns: 1fr; } }
</style>
