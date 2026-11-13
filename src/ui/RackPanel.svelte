<script lang="ts">
  import { DRIVE_SHAPES, INSERTS, INSERT_TYPES, type InsertType } from '../core/dsp/inserts';
  import { MAX_INSERTS, type InsertFx } from '../core/types';
  import { addInsert, moveInsert, removeInsert } from '../sound.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  // the rack on show is the selected track's, unless a group was picked in the mixer (or here)
  const bus = $derived(app.rackBus >= 0 ? p.buses[app.rackBus] : undefined);
  const target = $derived(bus ? -1 - app.rackBus : app.sel);
  const rack = $derived(bus ? bus.fx : t.fx);
  const name = $derived(bus ? bus.name : t.name);
  const color = $derived(bus ? 'var(--ink)' : `var(--t${t.color})`);
  let dragging = $state(-1);

  /** How a knob reads while it is turned. Most are plain numbers. */
  function format(fx: InsertFx, k: number): ((v: number) => string) | undefined {
    if (fx.type === 'duck' && k === 0) return (v) => (v === 0 ? 'SELF' : p.tracks[v - 1]?.name ?? 'SELF');
    if (fx.type === 'drive' && k === 3) return (v) => DRIVE_SHAPES[v < 43 ? 0 : v < 86 ? 1 : 2];
    if (fx.type === 'eq' && k < 3) return (v) => `${v >= 64 ? '+' : ''}${(((v - 64) / 63) * 15).toFixed(1)}dB`;
    if (fx.type === 'eq') return (v) => `${Math.round(200 * Math.pow(30, v / 127))}Hz`;
    if (fx.type === 'crush' && k === 0) return (v) => `${(16 - (v / 127) * 14).toFixed(1)}bit`;
    return undefined;
  }
  const maxOf = (fx: InsertFx, k: number) => (fx.type === 'duck' && k === 0 ? p.tracks.length : 127);
  const source = (fx: InsertFx) => (fx.p[0] > 0 && p.tracks[fx.p[0] - 1] ? p.tracks[fx.p[0] - 1].name : 'itself');

  // drag an effect by its handle to change the order the sound passes through them
  function grab(e: PointerEvent, i: number): void {
    if (e.button) return;
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function drag(e: PointerEvent): void {
    if (dragging < 0) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-fx]');
    if (!el) return;
    const to = +el.dataset.fx!;
    if (to === dragging) return;
    moveInsert(target, dragging, to);
    dragging = to;
  }
</script>

<div class="rack" style:--c={color}>
  <div class="bar">
    {#if p.buses.length}
      <div class="seg" role="radiogroup" aria-label="Whose effects">
        <button class:on={!bus} role="radio" aria-checked={!bus} onclick={() => (app.rackBus = -1)}>{t.name}</button>
        {#each p.buses as b, k}<button class:on={app.rackBus === k} role="radio" aria-checked={app.rackBus === k} onclick={() => (app.rackBus = k)}>{b.name}</button>{/each}
      </div>
    {/if}
    <span class="label">{name} effects</span>
    {#each INSERT_TYPES as type}
      <button class="btn ghost" disabled={rack.length >= MAX_INSERTS} onclick={() => addInsert(target, type as InsertType)}
        aria-label="Add {INSERTS[type].name}"><Icon name="plus" size={12} />{INSERTS[type].name}</button>
    {/each}
  </div>
  {#if !rack.length}
    <p class="empty">No effects on this {bus ? 'group' : 'track'} yet. Add an EQ, drive, chorus, crusher or a sidechain; the sound runs through them from left to right, and you can drag them into a different order.</p>
  {:else}
    <div class="chain">
      {#each rack as fx, i (i)}
        <div class="fx" class:off={!fx.on} class:moving={dragging === i} data-fx={i}>
          <header>
            <button class="grip" onpointerdown={(e) => grab(e, i)} onpointermove={drag} onpointerup={() => (dragging = -1)} onpointercancel={() => (dragging = -1)}
              aria-label="Drag to reorder {INSERTS[fx.type].name}" title="Drag to reorder">⋮⋮</button>
            <b>{INSERTS[fx.type].name}</b>
            <button class="pw" class:on={fx.on} onclick={() => (fx.on = !fx.on)} aria-pressed={fx.on} aria-label="{INSERTS[fx.type].name} on/off">{fx.on ? 'ON' : 'OFF'}</button>
            <button class="arrow" disabled={i === 0} onclick={() => moveInsert(target, i, i - 1)} aria-label="Move {INSERTS[fx.type].name} earlier">‹</button>
            <button class="arrow" disabled={i === rack.length - 1} onclick={() => moveInsert(target, i, i + 1)} aria-label="Move {INSERTS[fx.type].name} later">›</button>
            <button class="arrow" onclick={() => removeInsert(target, i)} aria-label="Remove {INSERTS[fx.type].name}">×</button>
          </header>
          <div class="k">
            {#each INSERTS[fx.type].knobs as knob, k}
              <Knob bind:value={fx.p[k]} max={maxOf(fx, k)} def={knob.def} label={knob.label} size={40} format={format(fx, k)} {color} />
            {/each}
          </div>
          {#if fx.type === 'duck'}<small>ducks when {source(fx)} plays</small>{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .rack { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .bar .label { margin-right: 8px; }
  .bar .seg { margin-right: 8px; }
  .bar .seg button { min-width: 0; padding: 0 8px; font-size: 10px; }
  .bar .btn { height: 28px; padding: 0 8px; font-size: 10px; gap: 3px; }
  .empty { margin: 6px 0; max-width: 560px; font-size: 13px; line-height: 1.45; color: var(--dim); }
  .chain { display: flex; flex-wrap: wrap; gap: 8px; }
  .fx {
    display: flex; flex-direction: column; gap: 6px; padding: 8px 9px 7px; border-radius: 12px; background: var(--inset);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.1); border: 1px solid transparent;
  }
  .fx.moving { border-color: var(--c); }
  .fx.off .k { opacity: 0.4; }
  header { display: flex; align-items: center; gap: 4px; }
  header b { flex: 1; font: 700 10px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; }
  .grip { border: 0; background: none; padding: 0 2px; color: var(--dim); font-size: 12px; letter-spacing: -2px; cursor: grab; touch-action: none; }
  .pw, .arrow {
    height: 18px; min-width: 18px; padding: 0 5px; border-radius: 5px; border: 1px solid var(--line); background: var(--raise); color: var(--dim);
    font: 700 9px var(--mono);
  }
  .pw.on { background: var(--c); color: #fff; border-color: transparent; }
  .arrow:disabled { opacity: 0.3; }
  .k { display: flex; }
  small { font: 600 9.5px var(--mono); color: var(--dim); }
</style>
