<script lang="ts">
  import { DRIVE_SHAPES, INSERTS, INSERT_TYPES, VOCAL_INSERTS, type InsertType } from '../core/dsp/inserts';
  import { VOCAL_CHAINS } from '../core/vocalchains';
  import { NOTE_NAMES, SCALES } from '../core/scales';
  import { MAX_INSERTS, type InsertFx } from '../core/types';
  import { addInsert, applyVocalChain, moveInsert, removeInsert } from '../sound.svelte';
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
    if (fx.type === 'tune' && k === 0) return (v) => (v >= 126.5 ? 'HARD' : `${Math.round(300 * Math.pow(0.004 / 0.3, v / 127))}ms`);
    if (fx.type === 'tune' && k === 1) return (v) => `${Math.round((v / 127) * 100)}%`;
    if (fx.type === 'tune' && k === 2) return (v) => (v >= 64 ? 'ANY NOTE' : 'SONG KEY');
    if ((fx.type === 'tune' && k === 3) || (fx.type === 'formant' && k === 0)) {
      const span = fx.type === 'tune' ? 6 : 12;
      return (v) => { const st = ((v - 64) / 64) * span; return `${st >= 0 ? '+' : ''}${st.toFixed(1)}`; };
    }
    if (fx.type === 'formant' && k === 1) return (v) => { const st = Math.round(((v - 64) / 64) * 12); return `${st >= 0 ? '+' : ''}${st}st`; };
    if (fx.type === 'harm' && k < 2) return (v) => { const st = Math.round(((v - 64) / 64) * 7); return st ? `${st > 0 ? '+' : ''}${st} step${Math.abs(st) === 1 ? '' : 's'}` : 'OFF'; };
    if (fx.type === 'comp' && k === 0) return (v) => `${-Math.round((v / 127) * 48)}dB`;
    if (fx.type === 'comp' && k === 1) return (v) => `${(1 + (v / 127) * 19).toFixed(1)}:1`;
    if (fx.type === 'comp' && k === 2) return (v) => `${(0.5 + (v / 127) * 60).toFixed(v < 20 ? 1 : 0)}ms`;
    if (fx.type === 'comp' && k === 3) return (v) => `+${Math.round((v / 127) * 24)}dB`;
    if (fx.type === 'deess' && k === 0) return (v) => `${(3 * Math.pow(4, v / 127)).toFixed(1)}kHz`;
    if (fx.type === 'deess' && k === 1) return (v) => `${-Math.round((v / 127) * 48)}dB`;
    return undefined;
  }
  const VOCAL_TIPS: Partial<Record<InsertType, string>> = {
    tune: 'Pitch correction: pulls each note onto the nearest note of the song\'s key. Slow is invisible, fast is the hard, stepped sound.',
    harm: 'Harmony: adds one or two voices above or below, in key, and can double the voice left and right.',
    formant: 'Formant: makes the voice sound bigger or smaller without changing its notes, or changes its notes without the chipmunk sound.',
    comp: 'Compressor: evens out loud and quiet words so every one of them is heard.',
    deess: 'De-esser: turns down harsh "s" and "t" sounds, and nothing else.',
  };
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
    {#each INSERT_TYPES.filter((x) => !VOCAL_INSERTS.includes(x)) as type}
      <button class="btn ghost" disabled={rack.length >= MAX_INSERTS} onclick={() => addInsert(target, type as InsertType)}
        aria-label="Add {INSERTS[type].name}"><Icon name="plus" size={12} />{INSERTS[type].name}</button>
    {/each}
  </div>
  <div class="bar">
    <span class="label">For a voice</span>
    {#each VOCAL_INSERTS as type}
      <button class="btn ghost" disabled={rack.length >= MAX_INSERTS} onclick={() => addInsert(target, type)}
        aria-label="Add {INSERTS[type].name}" title={VOCAL_TIPS[type]}><Icon name="plus" size={12} />{INSERTS[type].name}</button>
    {/each}
    {#if !bus}
      <select class="pick chain" value="" onchange={(e) => { if (e.currentTarget.value) applyVocalChain(app.sel, e.currentTarget.value); e.currentTarget.value = ''; }}
        aria-label="Vocal chain" title="A whole chain of effects for a vocal in one go. It replaces what is in this track's rack.">
        <option value="">Vocal chain…</option>
        {#each VOCAL_CHAINS as c}<option value={c.id} title={c.blurb}>{c.name}</option>{/each}
      </select>
    {/if}
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
              {#if knob.label !== '—'}<Knob bind:value={fx.p[k]} max={maxOf(fx, k)} def={knob.def} label={knob.label} size={40} format={format(fx, k)} {color} />{/if}
            {/each}
          </div>
          {#if fx.type === 'duck'}<small>ducks when {source(fx)} plays</small>{/if}
          {#if fx.type === 'tune' || fx.type === 'harm'}<small>in {NOTE_NAMES[p.scaleRoot]} {SCALES[p.scaleType].name.toLowerCase()}, about 30 ms late</small>{/if}
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
  .chain { height: 28px; font-size: 10px; margin-left: 6px; }
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
  .pw.on { background: var(--c); color: var(--on-c); border-color: transparent; }
  .arrow:disabled { opacity: 0.3; }
  .k { display: flex; }
  small { font: 600 9.5px var(--mono); color: var(--dim); }
</style>
