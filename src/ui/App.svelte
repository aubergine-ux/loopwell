<script lang="ts">
  import { onMount } from 'svelte';
  import { boot, handleFiles, play, projectChanged } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { autoConnectMidi } from '../audio/midi-in';
  import type { Project } from '../core/types';
  import { onKeyDown, onKeyUp, releaseAll } from '../keys';
  import { app, TABS } from '../state.svelte';
  import CommunityModal from './CommunityModal.svelte';
  import DemosModal from './DemosModal.svelte';
  import ExportModal from './ExportModal.svelte';
  import FxPanel from './FxPanel.svelte';
  import Grid from './Grid.svelte';
  import HelpModal from './HelpModal.svelte';
  import Icon from './Icon.svelte';
  import MixPanel from './MixPanel.svelte';
  import PresetsModal from './PresetsModal.svelte';
  import RackPanel from './RackPanel.svelte';
  import Pads from './Pads.svelte';
  import RollPanel from './RollPanel.svelte';
  import ShareModal from './ShareModal.svelte';
  import SongPanel from './SongPanel.svelte';
  import SoundPanel from './SoundPanel.svelte';
  import Timeline from './Timeline.svelte';
  import Transport from './Transport.svelte';

  boot();

  // any change to the beat goes to the audio thread, autosave and undo history
  $effect(() => projectChanged($state.snapshot(app.project) as Project));

  let dropping = $state(false);
  let dragDepth = 0;

  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  function dragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropping = true;
  }
  function dragLeave(): void {
    if (dragDepth > 0 && --dragDepth === 0) dropping = false;
  }
  function drop(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropping = false;
    // dropping on a track row or pad targets that track
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row],[data-pad]');
    const track = el ? +(el.dataset.row ?? el.dataset.pad)! : app.sel;
    void handleFiles([...(e.dataTransfer?.files ?? [])], track);
  }

  onMount(() => {
    void autoConnectMidi();
    // browsers only start audio after a gesture, so wake the engine on the first one
    const wake = () => void audio.resume();
    const gestures = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
    for (const g of gestures) addEventListener(g, wake, { capture: true, passive: true });
    addEventListener('blur', releaseAll);
    return () => {
      for (const g of gestures) removeEventListener(g, wake, { capture: true });
      removeEventListener('blur', releaseAll);
    };
  });
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />
<svelte:document ondragenter={dragEnter} ondragleave={dragLeave} ondragover={(e) => { if (hasFiles(e)) e.preventDefault(); }} ondrop={drop} />

<div class="stage">
  <main class="device">
    <Transport />
    {#if app.project.songMode}<Timeline />{:else}<Grid />{/if}
    <section class="lower">
      <div class="padwrap">
        <span class="label">Pads</span>
        <Pads />
      </div>
      <div class="panel">
        <div class="tabs" role="tablist">
          {#each TABS as t}
            <button role="tab" aria-selected={app.tab === t.id} class:on={app.tab === t.id} onclick={() => (app.tab = t.id)}>{t.label}</button>
          {/each}
        </div>
        <div class="content" role="tabpanel">
          {#if app.tab === 'sound'}<SoundPanel />
          {:else if app.tab === 'keys'}<RollPanel />
          {:else if app.tab === 'rack'}<RackPanel />
          {:else if app.tab === 'mix'}<MixPanel />
          {:else if app.tab === 'fx'}<FxPanel />
          {:else}<SongPanel />{/if}
        </div>
      </div>
    </section>
  </main>
  <footer>
    <span>Loopwell</span>
    <a href="https://github.com/aubergine-ux/loopwell" target="_blank" rel="noreferrer">GitHub</a>
    <span>MIT licence</span>
    <span>Press <kbd>?</kbd> for shortcuts</span>
  </footer>
</div>

{#if app.modal === 'share'}<ShareModal />
{:else if app.modal === 'export'}<ExportModal />
{:else if app.modal === 'demos'}<DemosModal />
{:else if app.modal === 'presets'}<PresetsModal />
{:else if app.modal === 'community'}<CommunityModal />
{:else if app.modal === 'help'}<HelpModal />{/if}

{#if app.needsTap}
  <button class="gate" onclick={play}>
    <span class="big"><Icon name="play" size={44} fill /></span>
    <b>{app.project.name}</b>
    <span>Tap to play</span>
  </button>
{/if}

{#if dropping}
  <div class="drop"><div><Icon name="download" size={30} /><b>Drop audio to use it as a sample</b><span>or a .loopwell project file to open it</span></div></div>
{/if}

{#if app.busy}
  <div class="busy" role="status">
    <b>{app.busy.label}</b>
    <div class="bar"><i style:width="{Math.round(app.busy.progress * 100)}%"></i></div>
  </div>
{/if}

{#if app.toast}
  {#key app.toast.id}
    <div class="toast" class:error={app.toast.kind === 'error'} role="status">{app.toast.msg}</div>
  {/key}
{/if}

<style>
  .stage { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 22px 16px 10px; gap: 10px; }
  .device {
    width: 100%; max-width: 1320px;
    background: var(--panel); border-radius: 26px; border: 1px solid var(--line);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .lower { display: grid; grid-template-columns: 178px minmax(0, 1fr); gap: 18px; padding: 16px 18px 18px; border-top: 1px solid var(--line); }
  .padwrap { display: flex; flex-direction: column; gap: 8px; }
  .panel { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .tabs { display: flex; gap: 4px; }
  .tabs button {
    height: 28px; padding: 0 14px; border: 0; border-radius: 8px; background: transparent;
    font: 700 11px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim);
    touch-action: manipulation;
  }
  .tabs button:hover { color: var(--ink); }
  .tabs button.on { background: var(--ink); color: var(--panel); }
  .content { min-height: 252px; }

  footer { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; font: 600 11px var(--mono); color: var(--dim); opacity: 0.85; padding: 4px 0 8px; }
  footer a { color: inherit; }
  footer kbd { font: inherit; padding: 1px 5px; border: 1px solid currentColor; border-radius: 4px; }
  :global([data-theme='slate']) footer, :global([data-theme='arcade']) footer, :global([data-theme='night']) footer { color: #9a9fab; }

  .gate {
    position: fixed; inset: 0; z-index: 80; border: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(10px); color: var(--ink);
    font-size: 15px;
  }
  .gate b { font-size: 30px; letter-spacing: -0.03em; }
  .gate .big {
    width: 112px; height: 112px; border-radius: 34px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center;
    box-shadow: 0 8px 0 color-mix(in srgb, var(--accent) 55%, #000), 0 30px 50px -10px rgb(0 0 0 / 0.5);
    animation: bob 1.4s ease-in-out infinite; margin-bottom: 14px;
  }
  @keyframes bob { 50% { transform: translateY(-6px); } }

  .drop { position: fixed; inset: 0; z-index: 70; padding: 18px; background: color-mix(in srgb, var(--bg) 70%, transparent); backdrop-filter: blur(4px); pointer-events: none; }
  .drop div {
    height: 100%; border: 3px dashed var(--accent); border-radius: 26px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    color: var(--ink); font-size: 14px;
  }
  .drop b { font-size: 22px; }

  .busy, .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 90;
    padding: 12px 18px; border-radius: 14px; background: var(--ink); color: var(--panel);
    font-size: 14px; font-weight: 600; box-shadow: 0 16px 40px -10px rgb(0 0 0 / 0.6); max-width: min(92vw, 520px);
  }
  .toast { animation: rise 0.22s cubic-bezier(.2,.9,.3,1.2); text-align: center; }
  .toast.error { background: var(--rec); color: #fff; }
  .busy { display: flex; flex-direction: column; gap: 8px; min-width: 240px; }
  .bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--panel) 25%, transparent); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width 120ms; }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, 12px); } }

  @media (max-width: 900px) {
    .stage { padding: 10px 8px; }
    .device { border-radius: 20px; }
    .lower { grid-template-columns: minmax(0, 1fr); padding: 14px 12px; }
    .tabs { overflow-x: auto; }
  }
</style>
