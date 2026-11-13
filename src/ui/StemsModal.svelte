<script lang="ts">
  import { audio } from '../audio/host';
  import { waveformPeaks } from '../core/analyze';
  import { MAX_TRACKS } from '../core/types';
  import { app } from '../state.svelte';
  import { MAX_SECONDS, MODEL_MB, STEMS, STEM_NAMES, type Stem } from '../stems/shared';
  import { cancelStems, chooseStemSource, forgetModel, splitStems, stems, stemsBusy, useStem } from '../stems.svelte';
  import { dragSound, dragSoundEnd } from './dragsound';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let picker = $state<HTMLInputElement>();
  let over = $state(false);
  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const busy = $derived(stemsBusy());
  const COLORS: Record<Stem, string> = { drums: 'var(--t0)', bass: 'var(--t6)', other: 'var(--t4)', vocals: 'var(--t7)' };
  const STAGE: Record<string, string> = {
    reading: 'Reading the file', model: `Getting the model (${MODEL_MB} MB, the first time only)`, starting: 'Starting the engine',
    splitting: 'Splitting', saving: 'Saving the stems',
  };
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function pick(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = '';
    if (f) void chooseStemSource(f);
  }
  function drop(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    over = false;
    const f = e.dataTransfer?.files[0];
    if (f) void chooseStemSource(f);
  }
  /** Draw a stem's outline once its audio is there. */
  function wave(node: HTMLCanvasElement, id: string) {
    const draw = () => {
      const data = audio.bank[id];
      const w = node.clientWidth, h = node.clientHeight;
      if (!data || !w) return;
      node.width = w; node.height = h;
      const g = node.getContext('2d')!;
      g.fillStyle = getComputedStyle(node).getPropertyValue('--c').trim() || '#888';
      const pk = waveformPeaks(data.l, w);
      for (let x = 0; x < w; x++) {
        const y0 = h / 2 - pk[x * 2 + 1] * (h / 2 - 1), y1 = h / 2 - pk[x * 2] * (h / 2 - 1);
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    };
    draw();
    return { update: (next: string) => { id = next; draw(); } };
  }
</script>

<Modal title="Split into stems" wide>
  <p class="rights"><b>Only split music you have the right to use.</b> Separating a recording doesn't change who owns it: sampling someone else's song
    still needs their permission, however it was taken apart. That is yours to sort out, not Loopwell's.</p>

  {#if !stems.source}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dropzone" class:over ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={drop}>
      <Icon name="wave" size={28} />
      <b>Drop a song or a loop here</b>
      <button class="btn on" onclick={() => picker?.click()} disabled={stems.stage === 'reading'}>{stems.stage === 'reading' ? 'Reading…' : 'Choose a file'}</button>
      <span>It is split into drums, bass, vocals and everything else, on this device. Nothing is uploaded.</span>
    </div>
  {:else}
    <div class="src">
      <div class="name"><b>{stems.source.name}</b><span>{clock(stems.source.seconds)}</span></div>
      {#if stems.source.seconds > MAX_SECONDS}
        <label class="from">
          <span class="label">Start at</span>
          <input type="range" min="0" max={Math.floor(stems.source.seconds - MAX_SECONDS)} step="1" bind:value={stems.from} disabled={busy}
            aria-label="Where the part to split starts" aria-valuetext={clock(stems.from)} />
          <b>{clock(stems.from)} – {clock(stems.from + MAX_SECONDS)}</b>
        </label>
        <p class="small">A stem is {MAX_SECONDS} seconds at most (as long as a sample can be), so pick the part you want.</p>
      {/if}
      <div class="row">
        {#if busy}
          <button class="btn" onclick={cancelStems}>Cancel</button>
        {:else}
          <button class="btn on" onclick={splitStems}>{stems.result ? 'Split again' : 'Split into stems'}</button>
          <button class="btn ghost" onclick={() => picker?.click()}>Another file</button>
        {/if}
      </div>
    </div>
  {/if}
  <input bind:this={picker} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.aif,.m4a" hidden onchange={pick} />

  {#if busy && stems.stage !== 'reading'}
    <div class="progress" role="status" aria-live="polite">
      <div class="what"><b>{STAGE[stems.stage]}</b><span>{stems.detail}{stems.stage === 'splitting' && stems.backend ? ` · ${stems.backend}` : ''}</span></div>
      <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stems.progress * 100)} aria-label={STAGE[stems.stage]}>
        <i class:wait={stems.stage === 'starting' || stems.stage === 'saving'} style:width="{Math.round(stems.progress * 100)}%"></i>
      </div>
      {#if stems.stage === 'splitting' && stems.backend === 'WebAssembly'}
        <p class="small">This browser has no WebGPU, so the split runs on the processor: expect it to take a few times as long as the music lasts.</p>
      {/if}
    </div>
  {/if}
  {#if stems.error}<p class="error" role="alert">{stems.error}</p>{/if}

  {#if stems.result}
    <ul class="stems">
      {#each STEMS as s}
        {@const id = stems.result[s]}
        <li style:--c={COLORS[s]} draggable="true" ondragstart={(e) => dragSound(e, id)} ondragend={dragSoundEnd} title="Drag onto a track, or use the buttons">
          <b>{STEM_NAMES[s]}</b>
          <button class="wave" onclick={() => audio.resume().then(() => audio.preview(id))} aria-label="Play the {s} stem"><canvas use:wave={id}></canvas></button>
          <button class="btn" onclick={() => { useStem(s); app.modal = null; }} title="Put this stem on {t.name}">Use on {t.name}</button>
          <button class="btn ghost sq" onclick={() => { useStem(s, true); app.modal = null; }} disabled={p.tracks.length >= MAX_TRACKS}
            aria-label="Put the {s} stem on a new track" title={p.tracks.length >= MAX_TRACKS ? 'All 8 tracks are in use' : 'On a new track'}><Icon name="plus" size={14} /></button>
        </li>
      {/each}
    </ul>
    <p class="small">Done in {stems.detail}. The stems are in your sounds (Browse → Imported), where they can be sliced, reversed and stretched like any other sample.</p>
  {/if}

  <p class="small foot">The model is HT-Demucs by Meta AI (MIT licence). It is downloaded once and kept by this browser, so later splits work offline.
    <button class="link" onclick={forgetModel} disabled={busy}>Remove the model</button></p>
</Modal>

<style>
  p { margin: 0 0 10px; font-size: 13px; line-height: 1.45; }
  .small { font-size: 12px; color: var(--dim); }
  .rights { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--t2) 22%, var(--inset)); }
  .dropzone {
    display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px 16px; border-radius: 14px; border: 2px dashed var(--line);
    text-align: center; font-size: 13px; color: var(--dim);
  }
  .dropzone.over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .dropzone b { font-size: 16px; color: var(--ink); }
  .src { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: var(--inset); }
  .name { display: flex; align-items: baseline; gap: 10px; }
  .name b { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name span, .from b { font: 600 11px var(--mono); color: var(--dim); white-space: nowrap; }
  .from { display: flex; align-items: center; gap: 10px; }
  .from input { flex: 1; min-width: 0; accent-color: var(--accent); }
  .src .small { margin: 0; }
  .row { display: flex; gap: 8px; }
  .progress { margin-top: 12px; }
  .what { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; margin-bottom: 6px; }
  .what span { font: 600 11px var(--mono); color: var(--dim); }
  .bar { height: 8px; border-radius: 4px; background: var(--well); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width 150ms; }
  .bar i.wait { width: 100% !important; opacity: 0.5; animation: wait 1s ease-in-out infinite alternate; }
  @keyframes wait { to { opacity: 0.15; } }
  .progress .small { margin: 8px 0 0; }
  .error { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--rec); color: var(--on-c); }
  .stems { list-style: none; margin: 14px 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .stems li { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 12px; background: var(--inset); border-left: 4px solid var(--c); cursor: grab; }
  .stems b { flex: 0 0 58px; font: 700 11px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
  .wave { flex: 1; min-width: 0; height: 40px; padding: 0; border: 0; border-radius: 8px; background: var(--well); }
  .wave canvas { width: 100%; height: 100%; display: block; }
  .stems .btn { height: 30px; font-size: 10px; max-width: 150px; overflow: hidden; }
  .foot { margin-top: 14px; }
  .link { border: 0; padding: 0; background: none; color: var(--ink); font: inherit; text-decoration: underline; }
  @media (max-width: 520px) { .stems li { flex-wrap: wrap; } .wave { flex-basis: 100%; order: 3; } }
</style>
