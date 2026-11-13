<script lang="ts">
  import { PERF_FX, PERF_HINTS, REPEAT_LABELS } from '../core/dsp/perf';
  import { PATTERN_NAMES, usesNotes } from '../core/types';
  import { learnClick, midimap } from '../midimap.svelte';
  import {
    LAUNCH_OFF, QUANTS, fxMove, fxRelease, fxToggle, launchClip, launchScene, patternOn, releaseAll, setFx, stage, stopTrack, toggleRecording,
  } from '../perform.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  // The live screen: every track's part in every pattern is a clip you can launch, a row
  // is a scene, and the pad on the right does things to the whole mix while a finger is on it.
  const p = $derived(app.project);
  const live = $derived(app.playing && !p.songMode);

  const filled = (t: number, pat: number) =>
    (usesNotes(p.tracks[t].kind) ? p.patterns[pat].notes[t].length > 0 : p.patterns[pat].steps[t].some((v) => v > 0));
  const sceneOn = (pat: number) => p.tracks.every((_, t) => patternOn(t) === pat);
  const anyOverride = $derived(stage.playing.some((v, t) => t < p.tracks.length && v !== undefined && v !== -1));

  function pad(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    if (e.type === 'pointerdown') {
      if (midimap.learning) return;
      el.setPointerCapture(e.pointerId);
    }
    if (!el.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    fxMove((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
  }
  function padKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === 'ArrowLeft') fxMove(stage.x - step, stage.y, stage.fxOn);
    else if (e.key === 'ArrowRight') fxMove(stage.x + step, stage.y, stage.fxOn);
    else if (e.key === 'ArrowUp') fxMove(stage.x, stage.y + step, stage.fxOn);
    else if (e.key === 'ArrowDown') fxMove(stage.x, stage.y - step, stage.fxOn);
    else if (e.key === ' ' || e.key === 'Enter') { if (!e.repeat) fxToggle(); } else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const readout = $derived(stage.fx === 1 ? REPEAT_LABELS[Math.min(4, Math.floor(stage.x * 5))] : `${Math.round(stage.x * 100)} · ${Math.round(stage.y * 100)}`);
  const recTime = $derived(`${Math.floor(stage.recSteps / 16) + 1}.${(Math.floor(stage.recSteps / 4) % 4) + 1}`);
</script>

<div class="stage">
  <div class="bar">
    <div class="group">
      <span class="label">Launch on</span>
      <div class="seg" role="radiogroup" aria-label="When a launched clip comes in">
        {#each QUANTS as q}
          <button class:on={stage.quant === q.steps} role="radio" aria-checked={stage.quant === q.steps} onclick={() => (stage.quant = q.steps)}
            title={q.steps ? `Launches wait for the next ${q.label.toLowerCase()}, so they always land in time` : 'Launches happen the moment you press'}>{q.label}</button>
        {/each}
      </div>
    </div>
    <button class="btn" onclick={releaseAll} disabled={!anyOverride} title="Every track goes back to playing the selected pattern">Release all</button>
    <span class="grow"></span>
    <button class="btn rec" class:on={stage.rec} aria-pressed={stage.rec} onclick={toggleRecording}
      title={stage.rec ? 'Stop, and put what you played on the timeline' : 'Record what you launch (and the filter pad) onto the song timeline'}>
      <i></i>{stage.rec ? `Stop · bar ${recTime}` : 'Record to song'}
    </button>
  </div>

  <div class="body">
    <div class="gridwrap">
      <div class="grid" style:--n={p.tracks.length} role="grid" aria-label="Clip launcher">
        <div class="row head" role="row">
          <span class="corner label" role="columnheader">Scene</span>
          {#each p.tracks as t, ti (ti)}
            <span class="th" style:--c="var(--t{t.color})" role="columnheader" class:off={t.mute}>{t.name}</span>
          {/each}
        </div>
        {#each PATTERN_NAMES as name, pi}
          <div class="row" role="row">
            <button class="scene" class:on={live && sceneOn(pi)} onclick={() => launchScene(pi)} aria-label="Launch scene {name}"
              title="Launch pattern {name} on every track"><Icon name="play" size={11} fill />{name}</button>
            {#each p.tracks as t, ti (ti)}
              {@const has = filled(ti, pi)}
              <button class="clip" class:has class:on={patternOn(ti) === pi} class:live={live && patternOn(ti) === pi} class:queued={stage.queued[ti] === pi}
                style:--c="var(--t{t.color})" role="gridcell" aria-selected={patternOn(ti) === pi}
                aria-label="{t.name}, pattern {name}{has ? '' : ', empty'}{stage.queued[ti] === pi ? ', waiting to start' : ''}"
                onclick={() => launchClip(ti, pi)}></button>
            {/each}
          </div>
        {/each}
        <div class="row foot" role="row">
          <span class="corner label">Stop</span>
          {#each p.tracks as t, ti (ti)}
            <button class="stop" class:on={patternOn(ti) === LAUNCH_OFF} class:queued={stage.queued[ti] === LAUNCH_OFF} onclick={() => stopTrack(ti)}
              aria-label="Stop {t.name}" title="Stop {t.name}"><Icon name="stop" size={11} fill /></button>
          {/each}
        </div>
      </div>
    </div>

    <div class="fx">
      <div class="seg" role="radiogroup" aria-label="Performance effect">
        {#each PERF_FX as f, i}
          <button class:on={stage.fx === i} role="radio" aria-checked={stage.fx === i} onclick={() => setFx(i)}>{f}</button>
        {/each}
      </div>
      <div class="pad" class:on={stage.fxOn} onpointerdown={pad} onpointermove={pad} onpointerup={fxRelease} onpointercancel={fxRelease}
        onkeydown={padKey} role="slider" tabindex="0" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stage.x * 100)}
        aria-valuetext="{stage.fxOn ? 'on' : 'off'}, {readout}"
        aria-label="{PERF_FX[stage.fx]} pad. Arrow keys move, space switches it on and off.">
        <i class="dot" style:left="{stage.x * 100}%" style:top="{(1 - stage.y) * 100}%"></i>
        <span class="read">{stage.fxOn ? readout : 'Touch'}</span>
      </div>
      {#if midimap.learning}
        <div class="learn" role="group" aria-label="Tie the pad to a controller">
          <span class="label">Learn</span>
          <button class="btn" onclick={() => learnClick('perf.x', 'Effect pad, left to right')}>Left–right</button>
          <button class="btn" onclick={() => learnClick('perf.y', 'Effect pad, up and down')}>Up–down</button>
          <button class="btn" onclick={() => learnClick('perf.on', 'Effect pad on/off')}>On/off</button>
        </div>
      {/if}
      <p>{PERF_HINTS[stage.fx]}</p>
      <label class="latch"><input type="checkbox" bind:checked={stage.latch} onchange={() => { if (!stage.latch) fxToggle(false); }} /> Latch: stays on when you let go</label>
    </div>
  </div>
</div>

<style>
  .stage { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 18px; }
  .bar { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
  .group { display: flex; flex-direction: column; gap: 5px; }
  .grow { flex: 1; }
  .rec { gap: 8px; }
  .rec i { width: 10px; height: 10px; border-radius: 50%; background: var(--rec); }
  .rec.on { background: var(--rec); color: #fff; }
  .rec.on i { background: #fff; animation: blink 1s steps(2, jump-none) infinite; }
  @keyframes blink { 50% { opacity: 0.3; } }

  .body { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 18px; align-items: start; }
  .gridwrap { overflow-x: auto; scrollbar-width: thin; }
  .grid { display: flex; flex-direction: column; gap: 5px; min-width: calc(64px + var(--n) * 58px); }
  .row { display: grid; grid-template-columns: 64px repeat(var(--n), minmax(0, 1fr)); gap: 5px; }
  .corner { align-self: center; }
  .th {
    font: 700 10px var(--mono); letter-spacing: 0.06em; text-align: center; padding: 3px 2px; border-radius: 6px;
    background: color-mix(in srgb, var(--c) 30%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .th.off { opacity: 0.45; }
  .scene, .stop {
    display: flex; align-items: center; justify-content: center; gap: 5px; height: 38px; border-radius: 9px; border: 1px solid var(--line);
    background: var(--raise); box-shadow: 0 2px 0 var(--edge), inset 0 1px 0 var(--hi); font: 700 13px var(--mono); touch-action: manipulation;
  }
  .scene:active, .stop:active { transform: translateY(2px); box-shadow: none; }
  .scene.on { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .stop { height: 28px; color: var(--dim); }
  .stop.on { background: var(--ink); color: var(--panel); }
  .clip {
    height: 38px; border-radius: 9px; border: 0; background: var(--well); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.14);
    position: relative; touch-action: manipulation;
  }
  .clip.has { background: color-mix(in srgb, var(--c) 38%, var(--well)); }
  .clip.has::after { content: ''; position: absolute; left: 8px; right: 8px; top: 50%; height: 4px; margin-top: -2px; border-radius: 2px; background: var(--c); }
  .clip.on { outline: 2px solid var(--ink); outline-offset: -2px; }
  .clip.live.has { background: var(--c); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.4); }
  .clip.live.has::after { background: #fff; }
  .clip.queued, .stop.queued { animation: wait 0.4s steps(2, jump-none) infinite; }
  @keyframes wait { 50% { outline: 2px dashed var(--ink); outline-offset: -2px; background: color-mix(in srgb, var(--ink) 20%, var(--well)); } }

  .fx { display: flex; flex-direction: column; gap: 10px; }
  .fx .seg { flex-wrap: wrap; }
  .fx .seg button { min-width: 0; padding: 0 8px; font-size: 10px; }
  .pad {
    position: relative; aspect-ratio: 1; border-radius: 16px; background: var(--inset); box-shadow: inset 0 1px 4px rgb(0 0 0 / 0.2);
    touch-action: none; cursor: crosshair; overflow: hidden;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 25% 25%; background-position: -1px -1px;
  }
  .pad:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pad.on { box-shadow: inset 0 0 0 3px var(--accent), inset 0 1px 4px rgb(0 0 0 / 0.2); }
  .dot { position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; background: var(--dim); opacity: 0.5; pointer-events: none; }
  .pad.on .dot { background: var(--accent); opacity: 1; box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 25%, transparent); }
  .read { position: absolute; left: 10px; bottom: 8px; font: 700 11px var(--mono); color: var(--dim); pointer-events: none; }
  p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--dim); min-height: 3.6em; }
  .learn { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .learn .btn { height: 26px; padding: 0 8px; font-size: 10px; }
  .latch { display: inline-flex; align-items: center; gap: 6px; font: 600 11px var(--mono); color: var(--dim); }

  @media (max-width: 820px) {
    .stage { padding: 12px; }
    .body { grid-template-columns: minmax(0, 1fr); }
    .fx { display: grid; grid-template-columns: minmax(0, 200px) minmax(0, 1fr); align-items: start; }
    .fx .seg, .fx .latch { grid-column: 1 / -1; }
    p { min-height: 0; }
  }
</style>
