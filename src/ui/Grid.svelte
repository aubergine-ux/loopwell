<script lang="ts">
  import { onMount } from 'svelte';
  import { addTrack, padDown, padUp, sampleMissing, setStep, stepVel } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { modChance, modCond, modLabel, modRatchet } from '../core/creative';
  import { DEFAULT_VEL, MAX_TRACKS, clamp, isPitched, usesSample } from '../core/types';
  import { isLocked } from '../live/session.svelte';
  import { app } from '../state.svelte';
  import { frameNo, lively, meterScale, onFlash, onFrame } from '../visual';
  import { byKeyboard } from './focus';
  import Icon from './Icon.svelte';

  let rows: HTMLElement;
  let scroller: HTMLElement;
  const p = $derived(app.project);
  const pat = $derived(p.patterns[app.pat]);

  /** Steps a synth note is still sounding on (after the step it starts). */
  function held(t: number, s: number): boolean {
    if (!isPitched(p.tracks[t].kind)) return false;
    for (const n of pat.notes[t]) if (s > n.s && s < n.s + n.l) return true;
    return false;
  }

  // --- painting steps with the pointer ---
  type Drag = { t: number; s: number; paint: number; startY: number; startVel: number; mode: 'tap' | 'paint' | 'vel'; fresh: boolean };
  let drag: Drag | null = null;
  let holdTimer = 0;

  /** Pick a step for the Tools panel to edit (right-click, or press and hold). */
  function pickStep(t: number, s: number): void {
    app.sel = t;
    app.step = { t, s };
    app.tab = 'tools';
  }
  function menu(e: MouseEvent): void {
    const c = cellOf(e.target as Element);
    if (!c) return;
    e.preventDefault();
    pickStep(c.t, c.s);
  }

  function cellOf(el: Element | null): { t: number; s: number } | null {
    const c = el?.closest<HTMLElement>('.cell');
    return c ? { t: +c.dataset.t!, s: +c.dataset.s! } : null;
  }

  function down(e: PointerEvent): void {
    if (e.button) return;
    const c = cellOf(e.target as Element);
    if (!c) return;
    app.sel = c.t;
    const v = stepVel(c.t, c.s);
    const fresh = v === 0;
    if (fresh) {
      setStep(c.t, c.s, DEFAULT_VEL);
      if (!app.playing) padTap(c.t);
    }
    drag = { ...c, paint: fresh ? DEFAULT_VEL : 0, startY: e.clientY, startVel: fresh ? DEFAULT_VEL : v, mode: 'tap', fresh };
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (!drag || drag.mode !== 'tap') return;
      drag.fresh = true; // a held step stays as it is rather than toggling off on release
      pickStep(drag.t, drag.s);
    }, 480);
    rows.setPointerCapture(e.pointerId);
  }

  function padTap(t: number): void {
    void audio.resume();
    audio.trigger(t, DEFAULT_VEL);
  }

  function move(e: PointerEvent): void {
    if (!drag) return;
    const dy = drag.startY - e.clientY;
    if (drag.mode === 'tap' && Math.abs(dy) > 6) drag.mode = 'vel';
    if (drag.mode === 'vel') {
      setStep(drag.t, drag.s, clamp(Math.round(drag.startVel + dy * 1.2), 1, 127));
      return;
    }
    const c = cellOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!c || c.t !== drag.t || c.s === drag.s) return;
    // dragging sideways paints the same on/off state along the row
    if (drag.mode === 'tap') {
      drag.mode = 'paint';
      if (!drag.fresh) setStep(drag.t, drag.s, 0);
    }
    drag.s = c.s;
    if ((stepVel(c.t, c.s) > 0) !== (drag.paint > 0)) setStep(c.t, c.s, drag.paint);
  }

  function up(): void {
    clearTimeout(holdTimer);
    if (drag && drag.mode === 'tap' && !drag.fresh) setStep(drag.t, drag.s, 0);
    drag = null;
  }

  // --- loop region: drag along the ruler to loop just those steps ---
  let ruler = $state<HTMLElement>();
  let anchor = -1, swept = false;
  const stepAt = (e: PointerEvent) => {
    const r = ruler!.getBoundingClientRect();
    return clamp(Math.floor(((e.clientX - r.left) / r.width) * p.steps), 0, p.steps - 1);
  };
  function rulerDown(e: PointerEvent): void {
    if (e.button) return;
    ruler!.setPointerCapture(e.pointerId);
    anchor = stepAt(e);
    swept = false;
  }
  function rulerMove(e: PointerEvent): void {
    if (anchor < 0 || !ruler!.hasPointerCapture(e.pointerId)) return;
    const s = stepAt(e);
    if (s === anchor && !swept) return;
    swept = true;
    app.range = { from: Math.min(anchor, s), to: Math.max(anchor, s) + 1 };
  }
  function rulerUp(): void {
    // a click without a drag takes the loop off again
    if (anchor >= 0 && !swept) app.range = null;
    anchor = -1;
  }
  function rulerKey(e: KeyboardEvent): void {
    if (!byKeyboard(e.currentTarget)) return;
    const r = app.range;
    const beat = 4;
    // Space is left alone: it always means play / stop
    if (e.key === 'Enter') app.range = r ? null : { from: 0, to: Math.min(p.steps, 16) };
    else if (e.key === 'Escape' && r) app.range = null;
    else if (r && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const d = e.key === 'ArrowLeft' ? -beat : beat;
      if (e.shiftKey) app.range = { from: r.from, to: clamp(r.to + d, r.from + 1, p.steps) }; // longer or shorter
      else if (r.from + d >= 0 && r.to + d <= p.steps) app.range = { from: r.from + d, to: r.to + d }; // moved along
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const outside = (s: number) => !!app.range && (s < app.range.from || s >= app.range.to);

  // Keyboard: Tab reaches one step of the grid, and from there the arrow keys walk it.
  // Enter switches a step on or off, + and - change how hard it hits, Shift+Enter opens its extras.
  let kc = $state({ t: 0, s: 0 });
  $effect(() => {
    if (kc.t >= p.tracks.length || kc.s >= p.steps) kc = { t: Math.min(kc.t, p.tracks.length - 1), s: Math.min(kc.s, p.steps - 1) };
  });
  function cellKey(e: KeyboardEvent, t: number, s: number): void {
    let nt = t, ns = s;
    const v = stepVel(t, s);
    if (e.key === 'Enter' && e.shiftKey) pickStep(t, s);
    else if (e.key === 'Enter') { setStep(t, s, v ? 0 : DEFAULT_VEL); if (!v && !app.playing) padTap(t); }
    // A step that was clicked has focus too, but someone using the mouse expects the arrow keys to go on
    // choosing tracks and patterns. The grid's own keys are for when focus got here by keyboard.
    else if (!byKeyboard(e.currentTarget)) return;
    else if ((e.key === '+' || e.key === '=') && v) setStep(t, s, clamp(v + 10, 1, 127));
    else if ((e.key === '-' || e.key === '_') && v) setStep(t, s, clamp(v - 10, 1, 127));
    else if (e.key === 'ArrowRight') ns = Math.min(p.steps - 1, s + (e.ctrlKey || e.metaKey ? 4 : 1));
    else if (e.key === 'ArrowLeft') ns = Math.max(0, s - (e.ctrlKey || e.metaKey ? 4 : 1));
    else if (e.key === 'ArrowDown') nt = Math.min(p.tracks.length - 1, t + 1);
    else if (e.key === 'ArrowUp') nt = Math.max(0, t - 1);
    else if (e.key === 'Home') ns = 0;
    else if (e.key === 'End') ns = p.steps - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (nt === t && ns === s) return;
    kc = { t: nt, s: ns };
    app.sel = nt;
    rows.querySelector<HTMLElement>(`.cell[data-t="${nt}"][data-s="${ns}"]`)?.focus();
  }

  // The playhead and the flash of each hit are a handful of overlay elements moved with transforms, which the
  // browser can do without repainting the grid. Marking the cells themselves cost a repaint of every one of
  // them on every step, and that is what dropped frames on slower machines.
  let headcol = $state<HTMLElement>();
  const pops = new Map<HTMLElement, Animation>();

  onMount(() => {
    let lit: Element[] = [];
    let meters: HTMLElement[] = [];
    const levels = new Float32Array(MAX_TRACKS);
    // where each step and each row is, measured when the grid changes shape rather than on every step
    let colX: number[] = [], colW = 0, rowY: number[] = [], rowH = 0, stale = true;
    const ro = new ResizeObserver(() => { stale = true; });
    ro.observe(rows);
    const measure = () => {
      colX = []; rowY = [];
      for (const c of rows.querySelectorAll<HTMLElement>('.cell[data-t="0"]')) { colX.push(c.offsetLeft); colW = c.offsetWidth; }
      for (const r of rows.querySelectorAll<HTMLElement>('.row[data-row]')) { rowY.push(r.offsetTop); rowH = r.offsetHeight; }
      stale = false;
    };
    const flashAt = (t: number, x: number) => {
      const el = rows.querySelector<HTMLElement>(`.pop[data-pop="${t}"]`);
      if (!el || rowY[t] === undefined) return;
      el.style.transform = `translate(${x}px, ${rowY[t]}px)`;
      if (el.style.width !== `${colW}px`) { el.style.width = `${colW}px`; el.style.height = `${rowH}px`; }
      // one animation per row, played again for each hit, instead of a new one every time
      const anim = pops.get(el);
      if (anim) { anim.cancel(); anim.play(); }
      else pops.set(el, (el.firstElementChild as HTMLElement).animate([{ transform: 'scale(1.3)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1)' }));
    };
    const offFrame = onFrame((head, changed) => {
      if (changed || (!head && lit.length)) {
        // the cells still carry the class (it says which step is sounding), but nothing is painted from it
        for (const el of lit) el.classList.remove('ph');
        lit = head ? [...rows.querySelectorAll(`.cell[data-s="${head.step}"]`)] : [];
        for (const el of lit) el.classList.add('ph');
        if (stale || colX.length !== p.steps || rowY.length !== p.tracks.length) measure();
        const x = head ? colX[head.step] : undefined;
        if (headcol) {
          if (x === undefined || !rowY.length) headcol.style.opacity = '0';
          else {
            headcol.style.transform = `translate(${x}px, ${rowY[0]}px)`;
            headcol.style.width = `${colW}px`;
            headcol.style.height = `${rowY[rowY.length - 1] + rowH - rowY[0]}px`;
            headcol.style.opacity = '1';
          }
        }
        if (x !== undefined && lively()) for (let t = 0; t < lit.length; t++) if (lit[t].classList.contains('on')) flashAt(t, x);
        // on narrow screens a 32-step grid scrolls; keep the playhead's half in view
        if (head && scroller.scrollWidth > scroller.clientWidth + 4 && (head.step & 15) === 0 && !drag) {
          const first = lit[0] as HTMLElement | undefined;
          if (first) scroller.scrollTo({ left: head.step === 0 ? 0 : first.offsetLeft - 120, behavior: 'smooth' });
        }
      }
      if (meters.length !== p.tracks.length) meters = [...rows.querySelectorAll<HTMLElement>('.meter i')];
      // the little level bars move on every other frame, taking turns with the mixer's
      if (frameNo & 1) return;
      for (let t = 0; t < meters.length; t++) {
        const next = Math.max(audio.peaks[t], levels[t] * 0.74);
        if (next === levels[t]) continue;
        levels[t] = next < 0.001 ? 0 : next;
        meterScale(meters[t], Math.sqrt(levels[t]), 'X');
      }
    });
    const bounces = new Map<Element, Animation>();
    const offFlash = onFlash((t, _vel, sequenced) => {
      // a hit from the pattern already flashes its step; the chip bounces for what you play yourself
      if (sequenced || !lively()) return;
      const chip = rows.querySelector(`.row[data-row="${t}"] .chip`);
      if (!chip) return;
      const anim = bounces.get(chip);
      if (anim) { anim.cancel(); anim.play(); }
      else bounces.set(chip, chip.animate([{ transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' }));
    });
    return () => { offFrame(); offFlash(); ro.disconnect(); pops.clear(); };
  });
</script>

<div class="scroller" bind:this={scroller}>
  <div class="rows" class:wide={p.steps === 32} bind:this={rows} style:--steps={p.steps}
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} oncontextmenu={menu} role="grid" tabindex="-1" aria-label="Step sequencer. Arrow keys move, Enter switches a step on or off, plus and minus change how hard it hits.">
    <i class="headcol" bind:this={headcol}></i>
    {#each p.tracks as t, ti (ti)}<i class="pop" data-pop={ti} style:--c="var(--t{t.color})"><b></b></i>{/each}
    <div class="row ruler">
      <div class="head rhead">
        <span class="label">{app.range ? `Loop ${app.range.from + 1}–${app.range.to}` : 'Loop'}</span>
        {#if app.range}<button class="unloop" onclick={() => (app.range = null)} aria-label="Loop the whole pattern again" title="Loop the whole pattern again">×</button>{/if}
      </div>
      <div class="cells ticks" bind:this={ruler} onpointerdown={rulerDown} onpointermove={rulerMove} onpointerup={rulerUp} onpointercancel={rulerUp}
        onkeydown={rulerKey} role="slider" tabindex="0" aria-label="Loop region" aria-valuemin={1} aria-valuemax={p.steps} aria-valuenow={(app.range?.from ?? 0) + 1}
        aria-valuetext={app.range ? `steps ${app.range.from + 1} to ${app.range.to}` : 'the whole pattern'}
        title="Drag across to loop just those steps. Click to loop the whole pattern again.">
        {#each { length: p.steps } as _, s}
          <i class="tick" class:in={!!app.range && !outside(s)} class:bar={s % 4 === 0}>{s % 4 === 0 ? s + 1 : ''}</i>
        {/each}
      </div>
    </div>
    {#each p.tracks as t, ti (ti)}
      <div class="row" class:sel={app.sel === ti} class:off={t.mute} data-row={ti} style:--c="var(--t{t.color})" role="row">
        <div class="head" role="rowheader">
          <button class="chip" aria-label="Play {t.name}" onpointerdown={(e) => { e.stopPropagation(); app.sel = ti; padDown(ti); }}
            onpointerup={() => padUp(ti)} onpointerleave={() => padUp(ti)}></button>
          <button class="name" onclick={() => { app.sel = ti; }}
            ondblclick={() => (app.tab = t.kind === 'synth' ? 'keys' : 'sound')} title="Select track (double-click to edit its sound)">
            <b>{t.name}</b>
            <span class="meter"><i></i></span>
          </button>
          {#if isLocked(ti)}<span class="locked" title="Locked by the session's host"><Icon name="lock" size={12} /></span>{/if}
          {#if usesSample(t.kind) && sampleMissing(t.sample)}<span class="warn" title="This track's custom sample isn't on this device. Drop a file on it to replace.">!</span>{/if}
          <button class="ms" class:on={t.mute} onclick={() => (t.mute = !t.mute)} aria-pressed={t.mute} aria-label="Mute {t.name}" title="Mute (M)">M</button>
          <button class="ms solo" class:on={t.solo} onclick={() => (t.solo = !t.solo)} aria-pressed={t.solo} aria-label="Solo {t.name}" title="Solo (Shift+M)">S</button>
        </div>
        <div class="cells">
          {#each { length: p.steps } as _, s}
            {@const v = stepVel(ti, s)}
            {@const m = pat.mods[ti]?.[s] ?? 0}
            <i class="cell" class:out={outside(s)} class:on={v > 0} class:hold={v === 0 && held(ti, s)} class:alt={(s >> 2) & 1} class:bar={s % 4 === 0}
              class:pick={app.step?.t === ti && app.step.s === s} class:maybe={v > 0 && (modChance(m) > 0 || modCond(m) > 0)}
              data-t={ti} data-s={s} data-roll={v > 0 && modRatchet(m) > 1 ? modRatchet(m) : null} style:--v={v ? (0.25 + (v / 127) * 0.75).toFixed(2) : null}
              role="gridcell" tabindex={kc.t === ti && kc.s === s ? 0 : -1} onfocus={() => { kc = { t: ti, s }; }} aria-label="{t.name} step {s + 1}{v ? `, velocity ${v}` : ''}{v && m ? `, ${modLabel(m)}` : ''}" aria-selected={v > 0}
              title={v && m ? modLabel(m) : null}
              onkeydown={(e) => cellKey(e, ti, s)}></i>
          {/each}
        </div>
      </div>
    {/each}
    {#if p.tracks.length < MAX_TRACKS}
      <div class="row add">
        <div class="head">
          <button class="btn ghost" onclick={() => addTrack('drum')}><Icon name="plus" size={13} />Drum</button>
          <button class="btn ghost" onclick={() => addTrack('synth')}><Icon name="plus" size={13} />Synth</button>
          <button class="btn ghost" onclick={() => addTrack('bass')} title="Add an 808 bass"><Icon name="plus" size={13} />808</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .scroller { overflow-x: auto; overflow-y: hidden; padding: 14px 18px; scrollbar-width: thin; }
  .rows { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: calc(var(--headw) + var(--steps) * 22px); --headw: 172px; outline: none; }
  .row { display: flex; align-items: stretch; gap: 10px; height: 36px; }
  .row.off .cells { opacity: 0.45; }
  .head {
    position: sticky; left: 0; z-index: 2;
    flex: 0 0 var(--headw); display: flex; align-items: center; gap: 6px;
    padding: 0 6px 0 5px; border-radius: 10px;
    background: var(--panel);
    transition: background 120ms;
  }
  .row.sel .head { background: var(--inset); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.12); }
  .chip {
    flex: none; width: 26px; height: 26px; border-radius: 8px; border: 0; will-change: transform;
    background: var(--c);
    box-shadow: 0 2px 0 color-mix(in srgb, var(--c) 60%, #000), inset 0 1px 0 rgb(255 255 255 / 0.35);
    touch-action: none;
  }
  .chip:active { transform: translateY(2px); box-shadow: none; }
  .name {
    flex: 1; min-width: 0; height: 100%; border: 0; background: none; padding: 0;
    display: flex; flex-direction: column; justify-content: center; gap: 4px; text-align: left;
  }
  .name b {
    font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meter { height: 3px; border-radius: 2px; background: var(--well); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--c); transform-origin: left; transform: scaleX(0); will-change: transform; }
  .locked { color: var(--dim); display: grid; place-items: center; }
  .warn {
    width: 16px; height: 16px; border-radius: 50%; background: var(--rec); color: var(--on-c);
    font: 700 11px/16px var(--mono); text-align: center; cursor: help;
  }
  .ms {
    flex: none; width: 22px; height: 22px; padding: 0; border-radius: 6px;
    border: 1px solid var(--line); background: var(--raise); color: var(--dim);
    font: 700 10px var(--mono);
    touch-action: manipulation;
  }
  .ms.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .ms.solo.on { background: var(--t2); color: #221a00; }

  .cells { flex: 1; display: grid; grid-template-columns: repeat(var(--steps), 1fr); gap: 4px; }
  .rows.wide .cells { gap: 3px; }
  .cell {
    position: relative; border-radius: 7px; background: var(--well);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.14);
    cursor: pointer; touch-action: pan-x; overflow: hidden;
    transition: background 90ms;
  }
  .rows.wide .cell { border-radius: 5px; }
  .cell.alt { background: var(--well-alt); }
  .cell.bar { margin-left: 3px; }
  .cell.bar:first-child { margin-left: 0; }
  .cell:hover { background: color-mix(in srgb, var(--c) 28%, var(--well)); }
  .cell.hold::after { content: ''; position: absolute; left: 0; right: 0; top: 42%; height: 16%; background: var(--c); opacity: 0.55; }
  /* an active step is a block of the track colour whose height is its velocity */
  .cell.on::before {
    content: ''; position: absolute; inset: 0; background: var(--c);
    transform: scaleY(var(--v)); transform-origin: bottom; border-radius: inherit;
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.4);
  }
  .cell.on { background: color-mix(in srgb, var(--c) 22%, var(--well)); box-shadow: none; }
  /* a roll shows as that many slices; a step that only sometimes plays is hatched */
  .cell[data-roll]::before { mask: repeating-linear-gradient(90deg, #000 0 calc(100% / var(--n) - 2px), transparent 0 calc(100% / var(--n))); }
  .cell[data-roll='2'] { --n: 2; }
  .cell[data-roll='3'] { --n: 3; }
  .cell[data-roll='4'] { --n: 4; }
  .cell.maybe::after {
    content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--panel) 55%, transparent) 3px 5px);
  }
  .cell.pick { outline: 2px dashed var(--ink); outline-offset: -2px; }
  .cell:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; z-index: 2; }
  /* the playhead: one column laid over the step that is sounding */
  .headcol {
    position: absolute; left: 0; top: 0; z-index: 1; opacity: 0; pointer-events: none; will-change: transform;
    border-radius: 8px; box-shadow: inset 0 0 0 2px var(--ink); background: color-mix(in srgb, var(--ink) 10%, transparent);
  }
  /* and a flash over each step as it hits, one per row */
  .pop { position: absolute; left: 0; top: 0; z-index: 1; pointer-events: none; will-change: transform; }
  .pop b { display: block; width: 100%; height: 100%; border-radius: 7px; background: color-mix(in srgb, var(--c) 55%, #fff); opacity: 0; will-change: transform, opacity; }

  .row.ruler { height: 16px; }
  .rhead { background: none; gap: 4px; }
  .rhead .label { font-size: 8.5px; }
  .unloop { width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: var(--ink); color: var(--panel); font: 700 10px/16px var(--mono); }
  .ticks { cursor: ew-resize; touch-action: none; border-radius: 5px; outline-offset: 2px; }
  .tick {
    display: flex; align-items: center; padding-left: 3px; border-radius: 4px; font: 700 8px var(--mono); font-style: normal; color: var(--dim);
    background: color-mix(in srgb, var(--well) 50%, transparent);
  }
  .tick.bar { margin-left: 3px; }
  .tick.bar:first-child { margin-left: 0; }
  .tick.in { background: var(--accent); color: var(--accent-ink); }
  .cell.out { opacity: 0.38; }
  @media (pointer: coarse) { .row.ruler { height: 26px; } }
  .row.add { height: 30px; }
  .row.add .head { background: none; flex-basis: auto; padding: 0; }
  .row.add .btn { height: 26px; font-size: 10px; padding: 0 8px; gap: 3px; }

  @media (max-width: 720px) {
    .scroller { padding: 12px; }
    .rows { --headw: 118px; }
    .ms.solo { display: none; }
  }
</style>
