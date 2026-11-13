<script lang="ts">
  import { onMount } from 'svelte';
  import { padDown, padUp } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { barsUpTo, tempoAt } from '../core/arrange';
  import { paramDef, paramsFor } from '../core/params';
  import { MAX_SONG_STEPS, PATTERN_NAMES, clamp, newId, type AutoLane, type Clip } from '../core/types';
  import {
    addClip, addLane, addMarker, addSig, addTempo, clearPoints, clipById, commitClip, deleteClip, duplicateClip, editClip,
    loopClip, removeLane, seek, setLaneParam, setLoop, setPoint, timelineLength,
  } from '../song.svelte';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';
  import Icon from './Icon.svelte';

  const narrow = matchMedia('(max-width: 720px)');
  let HEAD = $state(narrow.matches ? 104 : 150); // width of the sticky track names
  const ROW = 34;
  const LANE = 54;
  const PAD = 5; // breathing room above and below an automation curve

  const p = $derived(app.project);
  const a = $derived(p.arr);
  let px = $state(8); // pixels per 16th step
  let snapTo = $state<'bar' | 'beat' | 'step'>('bar');
  let scroller: HTMLElement;
  let inner: HTMLElement;
  let playEl: HTMLElement;

  const length = $derived(timelineLength());
  const bars = $derived(barsUpTo(p, length - 1));
  const sel = $derived(clipById(app.clip));

  type EventKind = 'marker' | 'tempo' | 'sig';
  let ev = $state<{ kind: EventKind; at: number } | null>(null);
  const evList = (kind: EventKind) => (kind === 'marker' ? a.markers : kind === 'tempo' ? a.tempo : a.sigs);
  const marker = $derived(ev?.kind === 'marker' ? a.markers.find((m) => m.at === ev!.at) : undefined);
  const tempo = $derived(ev?.kind === 'tempo' ? a.tempo.find((m) => m.at === ev!.at) : undefined);
  const sig = $derived(ev?.kind === 'sig' ? a.sigs.find((m) => m.at === ev!.at) : undefined);

  function snap(step: number, down = false): number {
    step = clamp(step, 0, MAX_SONG_STEPS - 1);
    if (snapTo === 'step') return down ? Math.floor(step) : Math.round(step);
    if (snapTo === 'beat') return (down ? Math.floor(step / 4) : Math.round(step / 4)) * 4;
    let best = 0;
    for (const b of bars) {
      if (down ? b.start <= step : Math.abs(b.start - step) <= Math.abs(best - step)) best = b.start;
      if (b.start > step) break;
    }
    return best;
  }
  const stepAt = (e: { clientX: number }) => (e.clientX - inner.getBoundingClientRect().left - HEAD) / px;
  function laneAt(e: PointerEvent): number | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-lane]');
    return el ? +el.dataset.lane! : null;
  }

  // --- clips: drag to move, drag an edge to resize, Alt-drag to copy ---
  type ClipDrag = { id: string; mode: 'move' | 'l' | 'r'; x0: number; orig: Clip; moved: boolean; copy: boolean };
  let drag: ClipDrag | null = null;

  function clipDown(e: PointerEvent, c: Clip): void {
    if (e.button) return;
    e.stopPropagation();
    ev = null;
    app.sel = c.track;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge = Math.min(9, r.width / 3);
    const mode = e.clientX > r.right - edge ? 'r' : e.clientX < r.left + edge ? 'l' : 'move';
    let id = c.id;
    const copy = mode === 'move' && (e.altKey || e.ctrlKey || e.metaKey);
    if (copy) {
      id = newId();
      a.clips.push({ ...($state.snapshot(c) as Clip), id });
    }
    app.clip = id;
    drag = { id, mode, x0: stepAt(e), orig: $state.snapshot(c) as Clip, moved: false, copy };
    inner.setPointerCapture(e.pointerId);
  }

  function clipMove(e: PointerEvent): void {
    if (!drag) return;
    const c = clipById(drag.id);
    if (!c) return;
    const o = drag.orig;
    const d = stepAt(e) - drag.x0;
    const row = drag.mode === 'move' ? laneAt(e) ?? c.track : o.track;
    if (!drag.moved && Math.abs(d * px) < 4 && row === o.track) return;
    drag.moved = true;
    const end = o.start + o.len;
    if (drag.mode === 'move') {
      c.start = clamp(snap(o.start + d), 0, MAX_SONG_STEPS - o.len);
      c.track = row;
    } else if (drag.mode === 'r') {
      c.len = clamp(snap(end + d) - o.start, 1, MAX_SONG_STEPS - o.start);
    } else {
      const start = clamp(snap(o.start + d), 0, end - 1);
      c.start = start;
      c.len = end - start;
      c.offset = (((o.offset + start - o.start) % p.steps) + p.steps) % p.steps;
    }
  }

  // The drag captures the pointer, so the browser never sees a double-click on the clip itself.
  let lastTap = { id: '', time: 0 };
  function clipUp(e: PointerEvent): void {
    if (!drag) return;
    const { id, moved, copy } = drag;
    drag = null;
    if (moved) { commitClip(id); return; }
    if (copy) { deleteClip(id); return; }
    if (lastTap.id === id && e.timeStamp - lastTap.time < 400) editClip(id);
    lastTap = { id, time: e.timeStamp };
  }

  function laneDown(t: number): void {
    app.sel = t;
    app.clip = null;
    ev = null;
  }

  /** Little picture of what the clip plays: one mark per hit or note. */
  function preview(c: Clip): string {
    const pat = p.patterns[c.pattern];
    const tr = p.tracks[c.track];
    if (!pat || !tr) return '';
    const h = ROW - 16;
    let d = '';
    if (tr.kind === 'drum' || tr.kind === 'dsyn') {
      const row = pat.steps[c.track];
      for (let k = 0; k < c.len; k++) {
        const v = row[(k + c.offset) % p.steps];
        if (!v) continue;
        const bh = Math.max(2, (v / 127) * h);
        d += `M${(k * px).toFixed(1)} ${(h - bh).toFixed(1)}h${Math.max(1, px - 1.5).toFixed(1)}v${bh.toFixed(1)}h-${Math.max(1, px - 1.5).toFixed(1)}z`;
      }
    } else {
      const notes = pat.notes[c.track];
      if (!notes.length) return '';
      let lo = 127, hi = 0;
      for (const n of notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
      const span = Math.max(1, hi - lo);
      for (let k = 0; k < c.len; k++) {
        const local = (k + c.offset) % p.steps;
        for (const n of notes) {
          if (n.s !== local) continue;
          const w = Math.max(1, Math.min(n.l, c.len - k) * px - 1.5);
          d += `M${(k * px).toFixed(1)} ${((1 - (n.p - lo) / span) * (h - 3)).toFixed(1)}h${w.toFixed(1)}v3h-${w.toFixed(1)}z`;
        }
      }
    }
    return d;
  }

  // --- ruler: click to move the cursor, drag to set the loop ---
  let ruler: { x0: number; moved: boolean } | null = null;
  function rulerDown(e: PointerEvent): void {
    if (e.button) return;
    ruler = { x0: stepAt(e), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function rulerMove(e: PointerEvent): void {
    if (!ruler) return;
    const x = stepAt(e);
    if (!ruler.moved && Math.abs((x - ruler.x0) * px) < 5) return;
    ruler.moved = true;
    setLoop(snap(ruler.x0), snap(x));
  }
  function rulerUp(e: PointerEvent): void {
    if (ruler && !ruler.moved) seek(snap(stepAt(e)));
    ruler = null;
  }

  // --- markers, tempo and time-signature flags ---
  let evDrag: { kind: EventKind; x0: number; at0: number } | null = null;
  function evDown(e: PointerEvent, kind: EventKind, at: number): void {
    if (e.button) return;
    e.stopPropagation();
    app.clip = null;
    ev = { kind, at };
    evDrag = { kind, x0: stepAt(e), at0: at };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function evMove(e: PointerEvent): void {
    if (!evDrag || !ev) return;
    const list = evList(evDrag.kind) as { at: number }[];
    const item = list.find((x) => x.at === ev!.at);
    if (!item) return;
    let at = evDrag.at0 + stepAt(e) - evDrag.x0;
    // signatures live on bar lines, whatever the snap setting
    if (evDrag.kind === 'sig') { let best = 0; for (const b of bars) if (b.start <= at + b.len / 2) best = b.start; at = best; } else at = snap(at);
    if (evDrag.kind === 'tempo') at = Math.max(1, at);
    if (at === item.at || list.some((x) => x.at === at)) return;
    item.at = at;
    list.sort((x, y) => x.at - y.at);
    ev.at = at;
  }
  function removeEvent(): void {
    if (!ev) return;
    if (ev.kind === 'marker') a.markers = a.markers.filter((m) => m.at !== ev!.at);
    else if (ev.kind === 'tempo') a.tempo = a.tempo.filter((m) => m.at !== ev!.at);
    else a.sigs = a.sigs.filter((m) => m.at !== ev!.at);
    ev = null;
  }
  function addEvent(kind: EventKind): void {
    const at = kind === 'tempo' ? Math.max(snapTo === 'step' ? 1 : 4, app.cursor) : app.cursor;
    if (kind === 'marker') addMarker(at);
    else if (kind === 'tempo') addTempo(at);
    else addSig(at);
    const made = kind === 'sig' ? [...a.sigs].reverse().find((s) => s.at <= at) : evList(kind).find((x) => x.at === at);
    ev = made ? { kind, at: made.at } : null;
    app.clip = null;
  }

  // --- automation: drag across a lane to draw, drag a point to move it ---
  const lanesOf = (t: number) => a.lanes.filter((l) => l.track === t);
  type AutoDrag = { lane: AutoLane; point: number; last: number };
  let auto: AutoDrag | null = null;
  const drawStep = () => (snapTo === 'step' ? 1 : 4);

  function laneValue(lane: AutoLane, e: PointerEvent, el: Element): { t: number; v: number } {
    const def = paramDef(lane.param)!;
    const r = el.getBoundingClientRect();
    const y = clamp((e.clientY - r.top - PAD) / (LANE - PAD * 2), 0, 1);
    return { t: (e.clientX - r.left) / px, v: Math.round(def.max - y * (def.max - def.min)) };
  }
  const pointY = (lane: AutoLane, v: number) => {
    const def = paramDef(lane.param)!;
    return PAD + (1 - (v - def.min) / (def.max - def.min)) * (LANE - PAD * 2);
  };
  function nearPoint(lane: AutoLane, e: PointerEvent, el: Element): number {
    const r = el.getBoundingClientRect();
    return lane.points.findIndex((pt) => Math.hypot(pt.t * px - (e.clientX - r.left), pointY(lane, pt.v) - (e.clientY - r.top)) < 9);
  }
  function autoDown(e: PointerEvent, lane: AutoLane): void {
    if (e.button) return;
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    const hit = nearPoint(lane, e, el);
    if (hit >= 0) { auto = { lane, point: hit, last: lane.points[hit].t }; return; }
    const { t, v } = laneValue(lane, e, el);
    const at = Math.max(0, Math.round(t / drawStep()) * drawStep());
    setPoint(lane, at, v);
    auto = { lane, point: -1, last: at };
  }
  function autoMove(e: PointerEvent): void {
    if (!auto) return;
    const { lane } = auto;
    const { t, v } = laneValue(lane, e, e.currentTarget as Element);
    if (auto.point >= 0) {
      const pts = lane.points, i = auto.point;
      const lo = i > 0 ? pts[i - 1].t + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1].t - 1 : MAX_SONG_STEPS;
      pts[i].t = clamp(Math.round(t), lo, hi);
      pts[i].v = v;
      return;
    }
    const at = Math.max(0, Math.round(t / drawStep()) * drawStep());
    clearPoints(lane, auto.last, at);
    setPoint(lane, at, v);
    auto.last = at;
  }
  function autoDbl(e: MouseEvent, lane: AutoLane): void {
    const hit = nearPoint(lane, e as PointerEvent, e.currentTarget as Element);
    if (hit >= 0) lane.points.splice(hit, 1);
  }
  function curve(lane: AutoLane): string {
    const pts = lane.points;
    if (!pts.length) return '';
    let d = `M0 ${pointY(lane, pts[0].v).toFixed(1)}`;
    for (const pt of pts) d += `L${(pt.t * px).toFixed(1)} ${pointY(lane, pt.v).toFixed(1)}`;
    return `${d}L${length * px} ${pointY(lane, pts[pts.length - 1].v).toFixed(1)}`;
  }

  function zoom(dir: number): void {
    const centre = (scroller.scrollLeft + (scroller.clientWidth - HEAD) / 2) / px;
    px = clamp(dir > 0 ? px * 1.5 : px / 1.5, 2, 28);
    requestAnimationFrame(() => { scroller.scrollLeft = centre * px - (scroller.clientWidth - HEAD) / 2; });
  }

  onMount(() => {
    const resize = () => (HEAD = narrow.matches ? 104 : 150);
    narrow.addEventListener('change', resize);
    const off = onFrame((head) => {
    if (!head || head.song < 0) {
      if (playEl.style.display !== 'none') playEl.style.display = 'none';
      return;
    }
    // glide between steps instead of hopping
    const pos = head.song + Math.min(1, audio.sinceHead() / (15 / tempoAt(p, head.song)));
    const x = pos * px;
    playEl.style.display = '';
    playEl.style.transform = `translateX(${(HEAD + x).toFixed(1)}px)`;
    if (drag || auto || ruler) return;
    const left = scroller.scrollLeft, w = scroller.clientWidth - HEAD;
    if (x < left || x > left + w - 24) scroller.scrollLeft = Math.max(0, x - 40);
    });
    return () => { off(); narrow.removeEventListener('change', resize); };
  });
</script>

<div class="tl" style:--head="{HEAD}px">
  <div class="tools">
    <div class="seg" title="What clips and flags snap to">
      {#each ['bar', 'beat', 'step'] as const as s}
        <button class:on={snapTo === s} onclick={() => (snapTo = s)}>{s}</button>
      {/each}
    </div>
    <button class="btn ghost sq" onclick={() => zoom(-1)} aria-label="Zoom out" title="Zoom out">−</button>
    <button class="btn ghost sq" onclick={() => zoom(1)} aria-label="Zoom in" title="Zoom in">+</button>
    <button class="btn" class:on={a.loopOn} onclick={() => { if (a.loopEnd > a.loopStart) a.loopOn = !a.loopOn; else setLoop(app.cursor, app.cursor + 64); }}
      aria-pressed={a.loopOn} title="Loop a section. Drag along the ruler to choose it."><Icon name="redo" size={13} />Loop</button>
    <span class="sep"></span>
    <button class="btn ghost" onclick={() => addClip(app.sel, app.cursor)} title="Add a clip of pattern {PATTERN_NAMES[app.pat]} at the cursor (or double-click a track)"><Icon name="plus" size={13} />Clip</button>
    <button class="btn ghost" onclick={() => addEvent('marker')} title="Add a marker at the cursor"><Icon name="plus" size={13} />Marker</button>
    <button class="btn ghost" onclick={() => addEvent('tempo')} title="Change tempo at the cursor"><Icon name="plus" size={13} />Tempo</button>
    <button class="btn ghost" onclick={() => addEvent('sig')} title="Change time signature at the cursor's bar"><Icon name="plus" size={13} />Time sig</button>

    <div class="edit">
      {#if sel}
        <span class="label">Clip</span>
        <div class="seg pats">
          {#each PATTERN_NAMES as name, i}
            <button class:on={sel.pattern === i} onclick={() => { sel.pattern = i; app.pat = i; }} aria-label="Use pattern {name}">{name}</button>
          {/each}
        </div>
        <button class="btn ghost" onclick={() => loopClip(sel.id)} title="Repeat the pattern once more">Loop +1</button>
        <button class="btn ghost" onclick={() => duplicateClip(sel.id)} title="Duplicate (Ctrl+D, or Alt-drag)"><Icon name="copy" size={13} />Copy</button>
        <button class="btn ghost" onclick={() => editClip(sel.id)} title="Open this pattern in the pattern view (double-click)">Edit</button>
        <button class="btn ghost sq" onclick={() => deleteClip(sel.id)} aria-label="Delete clip" title="Delete (Del)"><Icon name="trash" size={14} /></button>
      {:else if marker}
        <span class="label">Marker</span>
        <input class="txt" bind:value={marker.name} maxlength="24" aria-label="Marker name" spellcheck="false" />
        <button class="swatch" style:--c="var(--t{marker.color})" onclick={() => (marker.color = (marker.color + 1) % 8)} aria-label="Change marker colour"></button>
        <button class="btn ghost sq" onclick={removeEvent} aria-label="Delete marker"><Icon name="trash" size={14} /></button>
      {:else if tempo}
        <span class="label">Tempo</span>
        <input class="txt num" type="number" min="40" max="240" value={tempo.bpm} aria-label="Tempo from here"
          onchange={(e) => { const v = parseFloat((e.currentTarget as HTMLInputElement).value); if (Number.isFinite(v)) tempo.bpm = clamp(Math.round(v), 40, 240); }} />
        <span class="label">bpm</span>
        <button class="btn ghost sq" onclick={removeEvent} aria-label="Delete tempo change"><Icon name="trash" size={14} /></button>
      {:else if sig}
        <span class="label">Time</span>
        <select class="pick" bind:value={sig.num} aria-label="Beats per bar">{#each { length: 16 } as _, i}<option value={i + 1}>{i + 1}</option>{/each}</select>
        <select class="pick" bind:value={sig.den} aria-label="Beat unit">{#each [2, 4, 8, 16] as d}<option value={d}>{d}</option>{/each}</select>
        <button class="btn ghost sq" onclick={removeEvent} aria-label="Delete time signature"><Icon name="trash" size={14} /></button>
      {/if}
    </div>
  </div>

  <div class="scroll" bind:this={scroller}>
    <div class="inner" bind:this={inner} style:width="{HEAD + length * px}px"
      onpointermove={clipMove} onpointerup={clipUp} onpointercancel={clipUp} role="application" aria-label="Song timeline">
      <div class="lines" aria-hidden="true">
        {#each bars as b}<i style:left="{b.start * px}px" class:strong={b.index % 4 === 0}></i>{/each}
      </div>

      <div class="row rule">
        <div class="head"><span class="label">Bars</span></div>
        <div class="lane ruler" onpointerdown={rulerDown} onpointermove={rulerMove} onpointerup={rulerUp} onpointercancel={() => (ruler = null)}
          role="slider" tabindex="-1" aria-label="Song position" aria-valuenow={app.cursor} title="Click to move the cursor. Drag to loop a section.">
          {#if a.loopEnd > a.loopStart}
            <span class="loop" class:off={!a.loopOn} style:left="{a.loopStart * px}px" style:width="{(a.loopEnd - a.loopStart) * px}px"></span>
          {/if}
          {#each bars as b}
            {#if px * b.len >= 26 || b.index % 4 === 0}<b style:left="{b.start * px}px">{b.index + 1}</b>{/if}
          {/each}
          <span class="cursor" style:left="{app.cursor * px}px"></span>
        </div>
      </div>

      <div class="row meta">
        <div class="head"><span class="label">Markers</span></div>
        <div class="lane" ondblclick={(e) => { addMarker(snap(stepAt(e))); }} role="presentation" title="Double-click to add a marker">
          {#each a.markers as m (m.at)}
            <button class="flag" class:on={ev?.kind === 'marker' && ev.at === m.at} style:left="{m.at * px}px" style:--c="var(--t{m.color})"
              onpointerdown={(e) => evDown(e, 'marker', m.at)} onpointermove={evMove} onpointerup={() => (evDrag = null)}>{m.name}</button>
          {/each}
          {#each a.tempo as t (t.at)}
            <button class="flag low" class:on={ev?.kind === 'tempo' && ev.at === t.at} style:left="{t.at * px}px"
              onpointerdown={(e) => evDown(e, 'tempo', t.at)} onpointermove={evMove} onpointerup={() => (evDrag = null)}>♩ {t.bpm}</button>
          {/each}
          {#each a.sigs as s (s.at)}
            <button class="flag low sig" class:on={ev?.kind === 'sig' && ev.at === s.at} style:left="{s.at * px}px"
              onpointerdown={(e) => evDown(e, 'sig', s.at)} onpointermove={evMove} onpointerup={() => (evDrag = null)}>{s.num}/{s.den}</button>
          {/each}
        </div>
      </div>

      {#each p.tracks as t, ti (ti)}
        <div class="row trk" class:sel={app.sel === ti} class:off={t.mute} style:--c="var(--t{t.color})">
          <div class="head">
            <button class="chip" aria-label="Play {t.name}" onpointerdown={() => { app.sel = ti; padDown(ti); }} onpointerup={() => padUp(ti)} onpointerleave={() => padUp(ti)}></button>
            <button class="name" onclick={() => (app.sel = ti)}><b>{t.name}</b></button>
            <button class="ms" class:on={t.mute} onclick={() => (t.mute = !t.mute)} aria-pressed={t.mute} aria-label="Mute {t.name}">M</button>
            <button class="ms solo" class:on={t.solo} onclick={() => (t.solo = !t.solo)} aria-pressed={t.solo} aria-label="Solo {t.name}">S</button>
            <button class="ms" onclick={() => addLane(ti)} aria-label="Add automation to {t.name}" title="Add an automation lane">A</button>
          </div>
          <div class="lane clips" data-lane={ti} onpointerdown={() => laneDown(ti)} ondblclick={(e) => addClip(ti, snap(stepAt(e), true))} role="presentation">
            {#each a.clips.filter((c) => c.track === ti) as c (c.id)}
              <div class="clip" class:on={app.clip === c.id} style:left="{c.start * px}px" style:width="{c.len * px}px" data-clip={c.id}
                onpointerdown={(e) => clipDown(e, c)} ondblclick={(e) => e.stopPropagation()}
                role="button" tabindex="-1" aria-label="{t.name} pattern {PATTERN_NAMES[c.pattern]}, bar {Math.floor(c.start / 16) + 1}">
                <span class="pat">{PATTERN_NAMES[c.pattern]}</span>
                <svg width={c.len * px} height={ROW - 16} aria-hidden="true"><path d={preview(c)} /></svg>
                {#each { length: Math.max(0, Math.ceil((c.len + c.offset) / p.steps) - 1) } as _, k}
                  <i class="rep" style:left="{((k + 1) * p.steps - c.offset) * px}px"></i>
                {/each}
              </div>
            {/each}
          </div>
        </div>
        {#each lanesOf(ti) as l (l.id)}
          {@render lane(l, `var(--t${t.color})`)}
        {/each}
      {/each}

      <div class="row trk master">
        <div class="head">
          <span class="name"><b>MASTER</b></span>
          <button class="ms" onclick={() => addLane(-1)} aria-label="Add master automation" title="Add an automation lane">A</button>
        </div>
        <div class="lane"></div>
      </div>
      {#each lanesOf(-1) as l (l.id)}
        {@render lane(l, 'var(--accent)')}
      {/each}

      <div class="play" bind:this={playEl} style:display="none"></div>
    </div>
  </div>
</div>

{#snippet lane(l: AutoLane, color: string)}
  <div class="row auto" class:off={!l.on} style:--c={color}>
    <div class="head">
      <select class="pick" value={l.param} onchange={(e) => setLaneParam(l.id, (e.currentTarget as HTMLSelectElement).value)} aria-label="Automated knob">
        {#each paramsFor(p, l.track) as d}
          <option value={d.id} disabled={d.id !== l.param && a.lanes.some((x) => x.track === l.track && x.param === d.id)}>{d.label}</option>
        {/each}
      </select>
      <button class="ms" class:on={l.on} onclick={() => (l.on = !l.on)} aria-pressed={l.on} aria-label="Automation on" title="Turn this lane on or off">●</button>
      <button class="ms" onclick={() => removeLane(l.id)} aria-label="Remove automation lane" title="Remove lane">×</button>
    </div>
    <svg class="lane curve" width={length * px} height={LANE} data-auto={l.id}
      onpointerdown={(e) => autoDown(e, l)} onpointermove={autoMove} onpointerup={() => (auto = null)} onpointercancel={() => (auto = null)}
      ondblclick={(e) => autoDbl(e, l)} role="img" aria-label="{paramDef(l.param)?.label} automation, {l.points.length} points">
      <title>Drag to draw. Drag a point to move it, double-click it to remove it.</title>
      <path class="fill" d={l.points.length ? `${curve(l)}V${LANE}H0Z` : ''} />
      <path class="line" d={curve(l)} />
      {#each l.points as pt}<circle cx={pt.t * px} cy={pointY(l, pt.v)} r="3.2" />{/each}
    </svg>
  </div>
{/snippet}

<style>
  .tl { display: flex; flex-direction: column; }
  .tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 12px 18px 0; min-height: 44px; }
  .tools .btn { height: 30px; font-size: 10px; padding: 0 9px; gap: 4px; }
  .tools .btn.sq { padding: 0; width: 30px; font-size: 15px; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
  .edit { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
  .pats button { min-width: 24px; padding: 0 6px; }
  .txt {
    height: 30px; width: 130px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--raise);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  .txt.num { width: 64px; }
  .swatch { width: 22px; height: 22px; border-radius: 7px; border: 0; background: var(--c); }

  .scroll { overflow: auto; max-height: 440px; margin: 10px 18px 14px; border-radius: 12px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.16); scrollbar-width: thin; }
  .inner { position: relative; min-width: 100%; }
  .row { display: flex; position: relative; }
  .head {
    position: sticky; left: 0; z-index: 4; flex: 0 0 var(--head); width: var(--head); min-width: 0; overflow: hidden;
    display: flex; align-items: center; gap: 5px; padding: 0 6px;
    background: var(--panel); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  }
  .lane { position: relative; flex: 1; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
  .lines { position: absolute; left: var(--head); top: 0; bottom: 0; right: 0; pointer-events: none; }
  .lines i { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--line) 55%, transparent); }
  .lines i.strong { background: var(--line); }

  .rule { height: 24px; position: sticky; top: 0; z-index: 6; }
  .rule .head, .meta .head { background: var(--panel); }
  .ruler { background: var(--panel); cursor: text; touch-action: none; }
  .ruler b { position: absolute; top: 5px; padding-left: 4px; font: 700 10px var(--mono); color: var(--dim); pointer-events: none; }
  .loop { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 34%, transparent); border-inline: 2px solid var(--accent); pointer-events: none; }
  .loop.off { opacity: 0.35; }
  .cursor { position: absolute; top: 0; width: 0; height: 0; margin-left: -5px; border: 5px solid transparent; border-top: 7px solid var(--ink); pointer-events: none; }

  .meta { height: 40px; }
  .flag {
    position: absolute; top: 3px; height: 16px; padding: 0 6px; border: 0; border-radius: 0 5px 5px 0; border-left: 2px solid var(--c, var(--ink));
    background: color-mix(in srgb, var(--c, var(--ink)) 26%, var(--panel)); color: var(--ink);
    font: 700 9.5px/16px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; touch-action: none; cursor: grab; z-index: 1;
  }
  .flag.low { top: 21px; --c: var(--dim); text-transform: none; }
  .flag.sig { --c: var(--t5); }
  .flag.on { outline: 2px solid var(--ink); z-index: 2; }

  .trk { height: 34px; }
  .trk.off .clips { opacity: 0.45; }
  .trk.sel .head { background: var(--inset); }
  .chip { flex: none; width: 18px; height: 18px; border-radius: 6px; border: 0; background: var(--c); box-shadow: 0 2px 0 color-mix(in srgb, var(--c) 60%, #000); touch-action: none; }
  .chip:active { transform: translateY(2px); box-shadow: none; }
  .name { flex: 1; min-width: 0; border: 0; background: none; padding: 0; text-align: left; height: 100%; display: flex; align-items: center; }
  .name b { font: 700 10.5px var(--mono); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ms {
    flex: none; width: 20px; height: 20px; padding: 0; border-radius: 6px; border: 1px solid var(--line); background: var(--raise); color: var(--dim);
    font: 700 10px var(--mono); touch-action: manipulation;
  }
  .ms.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .ms.solo.on { background: var(--t2); color: #221a00; }
  .master .head { justify-content: space-between; }
  .master .name { color: var(--dim); }

  .clip {
    position: absolute; top: 3px; bottom: 3px; border-radius: 7px; overflow: hidden; cursor: grab; touch-action: none;
    background: color-mix(in srgb, var(--c) 30%, var(--panel)); border: 1px solid color-mix(in srgb, var(--c) 70%, var(--ink));
    box-shadow: 0 1px 0 rgb(0 0 0 / 0.18);
  }
  .clip::before, .clip::after { content: ''; position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize; }
  .clip::before { left: 0; }
  .clip::after { right: 0; }
  .clip.on { outline: 2px solid var(--ink); outline-offset: -1px; z-index: 2; background: color-mix(in srgb, var(--c) 48%, var(--panel)); }
  .clip .pat { position: absolute; left: 4px; top: 0; font: 700 9px/11px var(--mono); color: var(--ink); opacity: 0.8; pointer-events: none; }
  .clip svg { position: absolute; left: 0; top: 10px; pointer-events: none; }
  .clip path { fill: var(--c); }
  .rep { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed color-mix(in srgb, var(--ink) 50%, transparent); pointer-events: none; }

  .auto { height: 54px; }
  .auto .head { gap: 4px; }
  .auto .pick { flex: 1; min-width: 0; height: 24px; font-size: 10px; padding: 0 18px 0 6px; background-position: calc(100% - 11px) 10px, calc(100% - 6px) 10px; }
  .curve { display: block; flex: none; cursor: crosshair; touch-action: none; background: color-mix(in srgb, var(--c) 7%, transparent); }
  .curve .line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; }
  .curve .fill { fill: color-mix(in srgb, var(--c) 18%, transparent); stroke: none; }
  .curve circle { fill: var(--panel); stroke: var(--c); stroke-width: 2; }
  .auto.off .curve { opacity: 0.4; }

  .play { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; margin-left: -1px; background: var(--accent); z-index: 3; pointer-events: none; will-change: transform; }

  @media (max-width: 720px) {
    .tools { padding: 10px 12px 0; }
    .scroll { margin: 10px 12px 12px; }
    .ms.solo, .chip { display: none; }
    .head { gap: 3px; padding: 0 4px; }
    .edit { margin-left: 0; }
  }
</style>
