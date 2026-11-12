<script lang="ts">
  import { onMount } from 'svelte';
  import { tapTempo } from '../actions.svelte';
  import { audio } from '../audio/host';
  import { clamp } from '../core/types';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';

  let canvas: HTMLCanvasElement;
  let posEl: HTMLElement;
  let meterL: HTMLElement, meterR: HTMLElement, loadEl: HTMLElement;
  let editing = $state(false);
  let startY = 0, startV = 0, dragged = false;

  const p = $derived(app.project);

  function setBpm(v: number): void {
    p.bpm = clamp(Math.round(v), 40, 240);
  }
  function down(e: PointerEvent): void {
    if (e.button) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startY = e.clientY;
    startV = p.bpm;
    dragged = false;
  }
  function move(e: PointerEvent): void {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const d = startY - e.clientY;
    if (Math.abs(d) > 3) dragged = true;
    if (dragged) setBpm(startV + d / (e.shiftKey ? 12 : 3));
  }
  function key(e: KeyboardEvent): void {
    if (e.key === 'ArrowUp') setBpm(p.bpm + (e.shiftKey ? 10 : 1));
    else if (e.key === 'ArrowDown') setBpm(p.bpm - (e.shiftKey ? 10 : 1));
    else if (e.key === 'Enter') editing = true;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function wheel(node: HTMLElement) {
    const fn = (e: WheelEvent) => { e.preventDefault(); setBpm(p.bpm + (e.deltaY < 0 ? 1 : -1)); };
    node.addEventListener('wheel', fn, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', fn) };
  }
  function commitEdit(e: Event): void {
    const v = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v)) setBpm(v);
    editing = false;
  }
  const focus = (node: HTMLInputElement) => { node.focus(); node.select(); };

  onMount(() => {
    const ctx = canvas.getContext('2d')!;
    const data = new Uint8Array(1024);
    let fg = '', dim = '', w = 0, h = 0, l = 0, r = 0, quiet = 99;
    const readColors = () => {
      const cs = getComputedStyle(canvas);
      fg = cs.getPropertyValue('--lcd-fg').trim();
      dim = cs.getPropertyValue('--lcd-dim').trim();
    };
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      quiet = 0;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const mo = new MutationObserver(() => { readColors(); quiet = 0; });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    readColors();
    resize();

    const off = onFrame((head) => {
      // position readout: bar.beat.sixteenth
      const text = head ? `${head.songPos + 1}.${(head.step >> 2) + 1}.${(head.step & 3) + 1}` : '-.-.-';
      if (posEl.textContent !== text) posEl.textContent = text;

      // master meters fall back smoothly
      l = Math.max(audio.masterL, l * 0.9); r = Math.max(audio.masterR, r * 0.9);
      meterL.style.transform = `scaleX(${Math.min(1, l).toFixed(3)})`;
      meterR.style.transform = `scaleX(${Math.min(1, r).toFixed(3)})`;
      loadEl.textContent = `${Math.round(audio.load * 100)}%`;

      // scope: skip drawing once the line has gone flat
      const live = l + r > 0.002;
      quiet = live ? 0 : quiet + 1;
      if (quiet > 3 || !w) return;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = live ? fg : dim;
      ctx.beginPath();
      if (live && audio.scope(data)) {
        const n = 420;
        for (let i = 0; i < n; i += 2) {
          const x = (i / (n - 2)) * w, y = h / 2 - ((data[i] - 128) / 128) * (h / 2 - 2) * 1.3;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
      } else {
        ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      }
      ctx.stroke();
    });
    return () => { off(); ro.disconnect(); mo.disconnect(); };
  });
</script>

<div class="lcd">
  <div class="bpm">
    {#if editing}
      <input type="number" min="40" max="240" value={p.bpm} use:focus onblur={commitEdit}
        onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); if (e.key === 'Escape') editing = false; }} />
    {:else}
      <div class="num" role="spinbutton" tabindex="0" aria-label="Tempo" aria-valuenow={p.bpm} aria-valuemin={40} aria-valuemax={240}
        title="Drag to change tempo. Double-click to type." onpointerdown={down} onpointermove={move}
        ondblclick={() => (editing = true)} onkeydown={key} use:wheel>{p.bpm}</div>
    {/if}
    <button class="tap" onclick={tapTempo} title="Tap tempo (T)">BPM · TAP</button>
  </div>
  <div class="info">
    <div><span>PAT</span><b>{'ABCD'[app.pat]}{app.project.songMode ? ` ${app.songPos + 1}/${app.project.song.length}` : ''}</b></div>
    <div><span>POS</span><b bind:this={posEl}>-.-.-</b></div>
    <div><span>DSP</span><b bind:this={loadEl}>0%</b></div>
  </div>
  <div class="scope">
    <canvas bind:this={canvas}></canvas>
    <div class="vu"><i bind:this={meterL}></i></div>
    <div class="vu"><i bind:this={meterR}></i></div>
  </div>
</div>

<style>
  .lcd {
    display: flex; align-items: stretch; gap: 14px;
    height: 64px; padding: 8px 12px;
    background: var(--lcd-bg); color: var(--lcd-fg);
    border-radius: 12px;
    box-shadow: inset 0 2px 6px rgb(0 0 0 / 0.6), 0 1px 0 var(--hi);
    font-family: var(--mono);
    min-width: 0;
  }
  .bpm { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; width: 74px; }
  .num, .bpm input {
    font-size: 30px; font-weight: 700; line-height: 30px; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    cursor: ns-resize; touch-action: none;
    text-shadow: 0 0 12px color-mix(in srgb, var(--lcd-fg) 60%, transparent);
  }
  .bpm input {
    width: 74px; height: 30px; padding: 0; border: 0; background: transparent; color: inherit; outline: none;
    font-family: inherit; cursor: text; appearance: textfield; -moz-appearance: textfield;
    user-select: text; -webkit-user-select: text;
  }
  .bpm input::-webkit-inner-spin-button { display: none; }
  .tap {
    border: 0; background: none; padding: 0; color: var(--lcd-dim);
    font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
  }
  .tap:hover, .tap:active { color: var(--lcd-fg); }
  .info { display: flex; flex-direction: column; justify-content: space-between; font-size: 10px; min-width: 78px; }
  .info div { display: flex; gap: 8px; line-height: 14px; }
  .info span { color: var(--lcd-dim); font-weight: 700; letter-spacing: 0.1em; }
  .info b { font-weight: 700; font-variant-numeric: tabular-nums; }
  .scope { flex: 1; min-width: 70px; display: flex; flex-direction: column; gap: 2px; }
  canvas { flex: 1; width: 100%; min-height: 0; display: block; }
  .vu { height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--lcd-dim) 45%, transparent); overflow: hidden; }
  .vu i { display: block; height: 100%; background: var(--lcd-fg); transform-origin: left; transform: scaleX(0); }
  @media (max-width: 560px) { .info { display: none; } }
</style>
