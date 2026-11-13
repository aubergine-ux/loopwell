<script lang="ts">
  import { onMount } from 'svelte';
  import { auditionNote } from '../actions.svelte';
  import { CHORD_SIZES, CHORD_SIZE_LABELS, scaleChords, type Chord } from '../core/chords';
  import { ARP_MODES, ARP_RATE_LABELS, MAX_ARP_OCT } from '../core/creative';
  import { insertChord } from '../creative.svelte';
  import { NOTE_NAMES, SCALES, inScale, noteName, scalePitches } from '../core/scales';
  import { DEFAULT_VEL, clamp, type Note } from '../core/types';
  import { setKind } from '../sound.svelte';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';
  import Icon from './Icon.svelte';

  const ROW = 18;
  const LO = 24, HI = 96;
  const BLACK = [1, 3, 6, 8, 10];

  let scroller = $state<HTMLElement>();
  let lane = $state<HTMLElement>();
  let line = $state<HTMLElement>();

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const isSynth = $derived(t.kind !== 'drum'); // anything played by notes
  const sliced = $derived(t.kind === 'slice');
  const notes = $derived(p.patterns[app.pat].notes[app.sel]);

  // With scale lock on, only in-key rows exist, so a wrong note can't be drawn.
  // Notes that are already out of key keep their rows so they stay visible.
  const rows = $derived.by(() => {
    // a sliced sample has one row per slice instead of a keyboard
    if (sliced) return Array.from({ length: Math.max(1, t.slices.length) }, (_, i) => i).reverse();
    const set = new Set(p.scaleLock ? scalePitches(p.scaleRoot, p.scaleType, LO, HI) : Array.from({ length: HI - LO + 1 }, (_, i) => LO + i));
    for (const n of notes) set.add(n.p);
    return [...set].sort((a, b) => b - a);
  });
  const rowOf = (pitch: number) => rows.indexOf(pitch);

  // --- chords in key ---
  let chordSize = $state(0);
  let chordLen = $state(4);
  let chordAt = $state(0);
  let inversion = $state(0);
  const chords = $derived(scaleChords(p.scaleRoot, p.scaleType, CHORD_SIZES[chordSize]));
  $effect(() => { if (chordAt >= p.steps) chordAt = 0; });
  function addChord(c: Chord): void {
    insertChord(c, chordAt, chordLen, Math.floor(t.note / 12) * 12, inversion);
    chordAt = (chordAt + chordLen) % p.steps; // ready for the next one, so a progression is a row of clicks
  }

  type Drag = { kind: 'new' | 'resize' | 'move'; note: Note; grab: number; moved: boolean };
  let drag: Drag | null = null;

  function at(e: PointerEvent): { step: number; row: number } {
    const r = lane!.getBoundingClientRect();
    return {
      step: clamp(Math.floor(((e.clientX - r.left) / r.width) * p.steps), 0, p.steps - 1),
      row: clamp(Math.floor((e.clientY - r.top) / ROW), 0, rows.length - 1),
    };
  }

  function down(e: PointerEvent): void {
    if (e.button || !isSynth) return;
    const c = at(e);
    const el = (e.target as HTMLElement).closest<HTMLElement>('.note');
    if (el) {
      const note = notes[+el.dataset.n!];
      const r = el.getBoundingClientRect();
      const edge = r.width > 16 && e.clientX > r.right - 8;
      drag = { kind: edge ? 'resize' : 'move', note, grab: c.step - note.s, moved: false };
    } else {
      const note: Note = { s: c.step, l: 1, p: rows[c.row], v: DEFAULT_VEL };
      notes.push(note);
      drag = { kind: 'new', note: notes[notes.length - 1], grab: 0, moved: false };
      auditionNote(app.sel, note.p);
      t.note = note.p;
    }
    lane!.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent): void {
    if (!drag) return;
    const c = at(e);
    const n = drag.note;
    if (drag.kind === 'move') {
      const s = clamp(c.step - drag.grab, 0, p.steps - 1);
      const pitch = rows[c.row];
      if (s !== n.s || pitch !== n.p) drag.moved = true;
      n.s = s;
      if (pitch !== n.p) { n.p = pitch; auditionNote(app.sel, pitch, n.v); }
    } else {
      const l = clamp(c.step - n.s + 1, 1, p.steps - n.s);
      if (l !== n.l) { n.l = l; drag.moved = true; }
    }
  }

  function up(): void {
    if (!drag) return;
    // a plain click on a note removes it
    if (drag.kind === 'move' && !drag.moved) {
      const i = notes.indexOf(drag.note);
      if (i >= 0) notes.splice(i, 1);
    }
    drag = null;
  }

  // velocity lane: drag across the bars to draw velocities
  function velAt(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    const step = clamp(Math.floor(((e.clientX - r.left) / r.width) * p.steps), 0, p.steps - 1);
    const v = clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 127), 1, 127);
    for (const n of notes) if (n.s === step) n.v = v;
  }
  const stepVels = $derived.by(() => {
    const out = new Array<number>(p.steps).fill(0);
    for (const n of notes) if (n.s < p.steps && n.v > out[n.s]) out[n.s] = n.v;
    return out;
  });

  function centre(): void {
    if (!scroller || !isSynth) return;
    const pitches = notes.length ? notes.map((n) => n.p) : [t.note];
    const mid = (Math.max(...pitches) + Math.min(...pitches)) / 2;
    let best = 0;
    rows.forEach((r, i) => { if (Math.abs(r - mid) < Math.abs(rows[best] - mid)) best = i; });
    scroller.scrollTop = best * ROW - scroller.clientHeight / 2 + ROW;
  }
  // re-centre when switching track or pattern, not on every edit
  $effect(() => {
    void app.sel; void app.pat; void p.scaleLock;
    queueMicrotask(centre);
  });

  onMount(() => onFrame((head) => {
    if (!line) return;
    const on = !!head && head.pattern === app.pat;
    line.style.opacity = on ? '1' : '0';
    if (on) line.style.left = `${(head!.step / p.steps) * 100}%`;
  }));
</script>

<div class="roll">
  <div class="bar">
    <span class="label">Key</span>
    <select class="pick" bind:value={p.scaleRoot} aria-label="Key">
      {#each NOTE_NAMES as n, i}<option value={i}>{n}</option>{/each}
    </select>
    <select class="pick" bind:value={p.scaleType} aria-label="Scale">
      {#each SCALES as s, i}<option value={i}>{s.name}</option>{/each}
    </select>
    <button class="btn" class:on={p.scaleLock} onclick={() => (p.scaleLock = !p.scaleLock)} aria-pressed={p.scaleLock}
      title="Scale lock: only show notes that are in key">
      <Icon name={p.scaleLock ? 'lock' : 'unlock'} size={13} />Scale lock
    </button>
    <span class="grow"></span>
    {#if isSynth}
      <button class="btn ghost sq" onclick={() => scroller?.scrollBy({ top: -ROW * 7, behavior: 'smooth' })} aria-label="Scroll up an octave"><Icon name="up" /></button>
      <button class="btn ghost sq" onclick={() => scroller?.scrollBy({ top: ROW * 7, behavior: 'smooth' })} aria-label="Scroll down an octave"><Icon name="down" /></button>
      <button class="btn ghost" onclick={() => (p.patterns[app.pat].notes[app.sel] = [])}>Clear</button>
    {/if}
  </div>

  {#if t.kind === 'synth'}
    <div class="bar chordbar" style:--c="var(--t{t.color})">
      <span class="label">Chords</span>
      {#if chords.length}
        <div class="chords" role="group" aria-label="Chords in {NOTE_NAMES[p.scaleRoot]} {SCALES[p.scaleType].name}">
          {#each chords as c}
            <button class="chord" onclick={() => addChord(c)} title="Add {c.name} at step {chordAt + 1}"><small>{c.numeral}</small>{c.name}</button>
          {/each}
        </div>
        <div class="seg" role="group" aria-label="Chord size">
          {#each CHORD_SIZE_LABELS as l, i}<button class:on={chordSize === i} onclick={() => (chordSize = i)}>{l}</button>{/each}
        </div>
        <select class="pick" bind:value={chordLen} aria-label="Chord length" title="How long each chord lasts">
          <option value={2}>1/8</option><option value={4}>1/4</option><option value={8}>1/2</option><option value={16}>1 bar</option>
        </select>
        <select class="pick" bind:value={inversion} aria-label="Inversion" title="Inversion: which note of the chord is lowest">
          <option value={0}>Root</option><option value={1}>1st inv</option><option value={2}>2nd inv</option>
        </select>
        <select class="pick" bind:value={chordAt} aria-label="Step the next chord goes on" title="Where the next chord goes">
          {#each { length: p.steps } as _, s}{#if s % 2 === 0}<option value={s}>at {s + 1}</option>{/if}{/each}
        </select>
      {:else}
        <span class="none">Pick a scale other than Chromatic to get chords that fit it.</span>
      {/if}
      <span class="grow"></span>
      <span class="label">Arp</span>
      <select class="pick" bind:value={t.arpMode} aria-label="Arpeggiator" title="Arpeggiator: plays the notes of a held chord one after another">
        {#each ARP_MODES as m, i}<option value={i}>{m}</option>{/each}
      </select>
      {#if t.arpMode}
        <select class="pick" bind:value={t.arpRate} aria-label="Arpeggiator speed">
          {#each ARP_RATE_LABELS as r, i}<option value={i}>{r}</option>{/each}
        </select>
        <select class="pick" bind:value={t.arpOct} aria-label="Arpeggiator octaves">
          {#each { length: MAX_ARP_OCT } as _, i}<option value={i + 1}>{i + 1} oct</option>{/each}
        </select>
        <select class="pick" bind:value={t.arpGate} aria-label="Arpeggiator note length">
          <option value={40}>Short</option><option value={100}>Medium</option><option value={127}>Long</option>
        </select>
      {/if}
    </div>
  {/if}

  {#if !isSynth}
    <div class="hint">
      <b>{t.name}</b> is a drum track, so it has no notes to draw.
      <span>Pick a synth or sliced track, or turn this one into a synth.</span>
      <div class="hintbtns">
        {#each p.tracks as tr, i}
          {#if tr.kind !== 'drum'}<button class="btn" onclick={() => (app.sel = i)}>{tr.name}</button>{/if}
        {/each}
        <button class="btn ghost" onclick={() => setKind(app.sel, 'synth')}>Make {t.name} a synth</button>
      </div>
    </div>
  {:else}
    <div class="scroller" bind:this={scroller} style:--c="var(--t{t.color})" style:--steps={p.steps} style:--row="{ROW}px">
      <div class="inner" style:height="{rows.length * ROW}px">
        <div class="keys">
          {#each rows as pitch}
            {@const pc = pitch % 12}
            {#if sliced}
              <button class="key" tabindex="-1" onpointerdown={() => auditionNote(app.sel, pitch)} aria-label="Slice {pitch + 1}">{pitch + 1}</button>
            {:else}
              <button class="key" class:black={BLACK.includes(pc)} class:root={pc === p.scaleRoot} tabindex="-1"
                onpointerdown={() => auditionNote(app.sel, pitch)} aria-label={noteName(pitch)}>
                {pc === p.scaleRoot || pc === 0 ? noteName(pitch) : ''}
              </button>
            {/if}
          {/each}
        </div>
        <div class="lane" bind:this={lane} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}
          role="application" aria-label="Piano roll for {t.name}">
          {#each rows as pitch, i}
            {#if sliced ? pitch % 2 === 1 : pitch % 12 === p.scaleRoot || !inScale(pitch, p.scaleRoot, p.scaleType)}
              <i class="band" class:out={!sliced && !inScale(pitch, p.scaleRoot, p.scaleType)} style:top="{i * ROW}px"></i>
            {/if}
          {/each}
          {#each notes as n, ni}
            {#if n.s < p.steps && rowOf(n.p) >= 0}
              <i class="note" data-n={ni} style:left="{(n.s / p.steps) * 100}%" style:width="{(Math.min(n.l, p.steps - n.s) / p.steps) * 100}%"
                style:top="{rowOf(n.p) * ROW}px" style:--a={(0.45 + (n.v / 127) * 0.55).toFixed(2)}></i>
            {/if}
          {/each}
          <i class="line" bind:this={line}></i>
        </div>
      </div>
    </div>
    <div class="velrow" style:--c="var(--t{t.color})">
      <span class="label vl">Vel</span>
      <div class="vel" onpointerdown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); velAt(e); }} onpointermove={velAt}
        role="application" aria-label="Note velocities">
        {#each stepVels as v}
          <i><b style:height="{(v / 127) * 100}%"></b></i>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .roll { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .bar .btn { height: 30px; }
  .grow { flex: 1; }
  .chordbar .pick { height: 26px; font-size: 11px; }
  .chordbar .seg button { min-width: 0; padding: 0 7px; font-size: 10px; }
  .chords { display: flex; gap: 3px; flex-wrap: wrap; }
  .chord {
    display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 40px; height: 30px; padding: 0 6px;
    border: 0; border-radius: 7px; background: color-mix(in srgb, var(--c) 24%, var(--well)); color: var(--ink);
    font: 700 11px/1.05 var(--mono); touch-action: manipulation;
  }
  .chord small { font: 600 8px var(--mono); color: var(--dim); }
  .chord:hover { background: color-mix(in srgb, var(--c) 45%, var(--well)); }
  .chord:active { background: var(--c); color: #fff; }
  .none { font-size: 12px; color: var(--dim); }
  .scroller {
    height: 216px; overflow: auto; border-radius: 10px; background: var(--inset);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.16); scrollbar-width: thin; overscroll-behavior: contain;
  }
  .inner { display: flex; min-width: calc(46px + var(--steps) * 20px); }
  .keys { position: sticky; left: 0; z-index: 3; flex: 0 0 46px; display: flex; flex-direction: column; }
  .key {
    height: var(--row); flex: none; border: 0; border-bottom: 1px solid var(--line); padding: 0 5px;
    background: var(--raise); color: var(--dim);
    font: 600 9px/1 var(--mono); text-align: right; touch-action: manipulation;
  }
  .key.black { background: var(--ink); color: var(--panel); border-bottom-color: transparent; }
  .key.root { color: var(--c); font-weight: 800; }
  .key:active { background: var(--c); color: #fff; }
  .lane {
    position: relative; flex: 1; cursor: crosshair; touch-action: none;
    background-image:
      repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 26%, transparent) 0 1px, transparent 1px calc(400% / var(--steps))),
      repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px calc(100% / var(--steps))),
      repeating-linear-gradient(0deg, var(--line) 0 1px, transparent 1px var(--row));
  }
  .band { position: absolute; left: 0; right: 0; height: var(--row); background: color-mix(in srgb, var(--c) 13%, transparent); pointer-events: none; }
  .band.out { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--rec) 20%, transparent) 0 4px, transparent 4px 8px); }
  .note {
    position: absolute; height: calc(var(--row) - 2px); margin-top: 1px; border-radius: 5px; min-width: 6px;
    background: var(--c); opacity: var(--a);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.45), inset -3px 0 0 rgb(0 0 0 / 0.22), 0 1px 2px rgb(0 0 0 / 0.3);
    cursor: grab;
  }
  .line { position: absolute; top: 0; bottom: 0; width: calc(100% / var(--steps)); background: color-mix(in srgb, var(--ink) 14%, transparent); border-left: 2px solid var(--ink); opacity: 0; pointer-events: none; }
  .velrow { display: flex; align-items: stretch; height: 38px; }
  .vl { flex: 0 0 46px; align-self: center; }
  .vel { flex: 1; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; cursor: ns-resize; touch-action: none; }
  .vel i { display: flex; align-items: flex-end; background: var(--inset); border-radius: 3px; overflow: hidden; }
  .vel b { display: block; width: 100%; background: var(--c); border-radius: 3px 3px 0 0; }
  .hint {
    display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 22px; border-radius: 12px;
    background: var(--inset); font-size: 14px;
  }
  .hint span { color: var(--dim); font-size: 13px; }
  .hintbtns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
</style>
