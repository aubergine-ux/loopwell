<script lang="ts">
  import { exportAudio, exportMidiFile, exportStems, handleFiles, saveProjectFile, type AudioFormat } from '../actions.svelte';
  import { QUALITY_LABELS } from '../core/encode';
  import { LOUDNESS_TARGETS, type LoudnessTarget } from '../core/loudness';
  import { songEnd, stepToSeconds } from '../core/arrange';
  import { PATTERN_NAMES } from '../core/types';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let picker: HTMLInputElement;
  const p = $derived(app.project);
  const secs = $derived(Math.round(stepToSeconds(p, songEnd(p.arr))));
  const what = $derived(p.songMode
    ? `the whole song (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')})`
    : `pattern ${PATTERN_NAMES[app.pat]}, once through. Switch to Song view to export the whole timeline`);

  const FORMATS: { id: AudioFormat; name: string; blurb: string }[] = [
    { id: 'wav', name: 'WAV', blurb: '24-bit, nothing lost' },
    { id: 'mp3', name: 'MP3', blurb: 'Plays anywhere' },
    { id: 'ogg', name: 'OGG', blurb: 'Smaller, open format' },
  ];
  let format = $state<AudioFormat>('wav');
  let loudness = $state<LoudnessTarget>('off');
  let quality = $state(1);
  const target = $derived(LOUDNESS_TARGETS.find((t) => t.id === loudness)!);

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
    <div class="audio">
      <div class="opts">
        <div class="seg" role="radiogroup" aria-label="File format">
          {#each FORMATS as f}
            <button class:on={format === f.id} role="radio" aria-checked={format === f.id} onclick={() => (format = f.id)} title={f.blurb}>{f.name}</button>
          {/each}
        </div>
        {#if format !== 'wav'}
          <div class="seg" role="radiogroup" aria-label="Quality">
            {#each QUALITY_LABELS as q, i}<button class:on={quality === i} role="radio" aria-checked={quality === i} onclick={() => (quality = i)}>{q}</button>{/each}
          </div>
        {/if}
        <label class="loud"><span class="label">Loudness</span>
          <select class="pick" bind:value={loudness} aria-label="Loudness of the exported file">
            {#each LOUDNESS_TARGETS as t}<option value={t.id}>{t.label}</option>{/each}
          </select>
        </label>
      </div>
      <button onclick={() => run(() => exportAudio(format, loudness, quality))}>
        <Icon name="wave" size={22} />
        <span><b>{FORMATS.find((f) => f.id === format)!.name}</b><small>The full mix with effects. {target.blurb}{loudness === 'off' || loudness === 'peak' ? '' : ', turned up or down to get there without clipping'}.</small></span>
      </button>
    </div>
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
  .list > button, .audio > button {
    display: flex; align-items: center; gap: 14px; text-align: left; padding: 12px 14px;
    border-radius: 14px; border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 3px 0 var(--edge), inset 0 1px 0 var(--hi);
    transition: transform 60ms, box-shadow 60ms;
  }
  .list > button:active, .audio > button:active { transform: translateY(3px); box-shadow: none; }
  .list > button > span, .audio > button > span { display: flex; flex-direction: column; gap: 2px; }
  .list > button b, .audio > button b { font-size: 15px; }
  .list > button small, .audio > button small { font-size: 12px; color: var(--dim); }
  .audio { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 16px; background: var(--inset); }
  .opts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .opts .seg button { min-width: 0; padding: 0 10px; }
  .loud { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
  .loud .pick { height: 28px; font-size: 11px; }
  @media (max-width: 480px) { .list.two { grid-template-columns: 1fr; } }
</style>
