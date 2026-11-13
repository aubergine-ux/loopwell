<script lang="ts">
  import { stop } from '../actions.svelte';
  import { app } from '../state.svelte';
  import { endTour, tour, tourNext } from '../tour.svelte';
  import Icon from './Icon.svelte';

  const step = $derived(tour.steps[app.tour]);
  const finished = $derived(app.tour >= tour.steps.length);
  const lesson = $derived(!!tour.lesson);
  function lessons(): void {
    endTour();
    app.modal = 'learn';
  }
  let box = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let card = $state<HTMLElement>();
  let place = $state({ left: 0, top: 0 });

  // follows what it is pointing at frame by frame, but only while a step is showing: the rest of the time nothing runs
  $effect(() => {
    if (app.tour < 0 || finished) { box = null; return; }
    let raf = 0, held = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (app.tour < 0 || finished) return;
      const el = document.querySelector<HTMLElement>(step.target);
      const r = el?.getBoundingClientRect();
      if (r && r.width && (box?.x !== r.left || box.y !== r.top || box.w !== r.width || box.h !== r.height)) box = { x: r.left, y: r.top, w: r.width, h: r.height };
      if (!r || !r.width) box = null;
      // the card sits under what it is about, or over it when there is no room below
      const ch = card?.offsetHeight ?? 150, cw = card?.offsetWidth ?? 320;
      if (box) {
        const under = box.y + box.h + 14;
        const top = under + ch < innerHeight - 8 ? under : Math.max(8, box.y - ch - 14);
        const left = Math.min(innerWidth - cw - 8, Math.max(8, box.x + Math.min(box.w / 2, 260) - cw / 2));
        if (place.left !== left || place.top !== top) place = { left, top };
      }
      // done: show the tick for a moment, then move on
      if (!tour.ticked && step.done()) { tour.ticked = true; held = performance.now(); }
      if (tour.ticked && performance.now() - held > 750) tourNext();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  function templates(): void {
    endTour();
    app.modal = 'demos';
    app.beats = 'templates';
  }
</script>

{#if app.tour >= 0 && !finished}
  {#if box}<div class="spot" class:ok={tour.ticked} style:left="{box.x - 6}px" style:top="{box.y - 6}px" style:width="{box.w + 12}px" style:height="{box.h + 12}px"></div>{/if}
  <div class="card" class:float={!!box} bind:this={card} style:left={box ? `${place.left}px` : null} style:top={box ? `${place.top}px` : null}
    role="dialog" aria-label="{tour.name}, step {app.tour + 1} of {tour.steps.length}" aria-live="polite">
    <header>
      <span class="n" class:ok={tour.ticked}>{#if tour.ticked}<Icon name="check" size={13} />{:else}{app.tour + 1}{/if}</span>
      <b>{step.title}</b>
      <span class="of">{app.tour + 1} / {tour.steps.length}</span>
    </header>
    <p>{step.text}</p>
    <footer>
      <button class="btn ghost" onclick={endTour}>{lesson ? 'End the lesson' : 'End the walkthrough'}</button>
      <button class="btn" onclick={tourNext}>Skip this step</button>
    </footer>
  </div>
{:else if finished && lesson}
  <div class="card done" role="dialog" aria-label="Lesson finished" aria-live="polite">
    <header><span class="n ok"><Icon name="check" size={13} /></span><b>{tour.end.title}</b></header>
    <p>{tour.end.text}</p>
    <footer>
      <button class="btn ghost" onclick={endTour}>Keep playing with it</button>
      <button class="btn on" onclick={lessons}>More lessons</button>
    </footer>
  </div>
{:else if finished}
  <div class="card done" role="dialog" aria-label="Walkthrough finished" aria-live="polite">
    <header><span class="n ok"><Icon name="check" size={13} /></span><b>That's a beat, and you made it</b></header>
    <p>Everything else in Loopwell is more of the same: more tracks, more patterns, a timeline to arrange them on. Press <kbd>?</kbd> for the shortcuts, or
      <kbd>Ctrl</kbd>+<kbd>K</kbd> to find anything by name.</p>
    <footer>
      <button class="btn ghost" onclick={() => { endTour(); stop(); }}>Close</button>
      <button class="btn" onclick={templates}>Try a template</button>
      <button class="btn on" onclick={() => { endTour(); app.modal = 'share'; }}>Share it</button>
    </footer>
  </div>
{/if}

<style>
  /* the spotlight darkens everything but what it surrounds, and lets clicks through to it */
  .spot {
    position: fixed; z-index: 40; border-radius: 12px; pointer-events: none;
    border: 2px solid var(--accent); box-shadow: 0 0 0 200vmax rgb(0 0 0 / 0.32);
    transition: left 0.2s, top 0.2s, width 0.2s, height 0.2s;
  }
  .spot.ok { border-color: var(--t3); }
  .card {
    position: fixed; z-index: 45; left: 50%; bottom: 18px; width: min(340px, calc(100vw - 16px)); transform: translateX(-50%);
    padding: 12px 14px 10px; border-radius: 16px; background: var(--panel); border: 1px solid var(--line);
    box-shadow: 0 24px 50px -14px rgb(0 0 0 / 0.6), inset 0 1px 0 var(--hi);
  }
  .card.float { transform: none; bottom: auto; transition: left 0.2s, top 0.2s; }
  .card.done { width: min(420px, calc(100vw - 16px)); }
  header { display: flex; align-items: center; gap: 8px; }
  header b { flex: 1; font-size: 15px; }
  .n { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font: 700 11px var(--mono); }
  .n.ok { background: var(--t3); color: var(--on-c); }
  .of { font: 600 10px var(--mono); color: var(--dim); }
  p { margin: 8px 0 10px; font-size: 13px; line-height: 1.45; }
  kbd { font: 600 10px var(--mono); padding: 1px 5px; border-radius: 5px; border: 1px solid var(--line); background: var(--raise); }
  footer { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
  footer .btn { height: 28px; font-size: 10px; padding: 0 10px; }
  @media (prefers-reduced-motion: reduce) { .spot, .card.float { transition: none; } }
  @media (max-width: 640px) {
    /* on a phone the card stays at the bottom, out of the way of the thing it is pointing at */
    .card.float { left: 50% !important; top: auto !important; bottom: 10px; transform: translateX(-50%); }
  }
</style>
