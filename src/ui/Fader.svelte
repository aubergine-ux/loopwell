<script lang="ts">
  import { clamp } from '../core/types';
  import { isLearning, learnKnob } from '../midimap.svelte';

  let { value = $bindable(), min = 0, max = 127, def = 100, label, color = 'var(--accent)', height = 112 }:
    { value: number; min?: number; max?: number; def?: number; label: string; color?: string; height?: number } = $props();

  const frac = $derived((value - min) / (max - min));
  let startY = 0, startV = 0;

  function set(v: number): void {
    v = Math.round(clamp(v, min, max));
    if (v !== value) value = v;
  }
  function down(e: PointerEvent): void {
    if (e.button) return;
    if (isLearning()) { learnKnob(label, min, max, value, (v) => { value = v; }); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startY = e.clientY;
    startV = value;
  }
  function move(e: PointerEvent): void {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    set(startV + ((startY - e.clientY) / (height - 22)) * (max - min) * (e.shiftKey ? 0.25 : 1));
  }
  function key(e: KeyboardEvent): void {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value + step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value - step);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="fader" style:height="{height}px" role="slider" tabindex="0" aria-label={label} aria-orientation="vertical"
  aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} title="{label}: {value}"
  onpointerdown={down} onpointermove={move} ondblclick={() => set(def)} onkeydown={key}>
  <i class="slot"><i class="fill" style:height="{frac * 100}%" style:background={color}></i></i>
  <i class="cap" style:bottom="{frac * (height - 22)}px"></i>
</div>

<style>
  .fader { position: relative; width: 30px; cursor: ns-resize; touch-action: none; }
  .slot {
    position: absolute; left: 12px; top: 0; bottom: 0; width: 6px; border-radius: 3px;
    background: var(--well); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.25); overflow: hidden;
    display: flex; align-items: flex-end;
  }
  .fill { width: 100%; opacity: 0.85; }
  .cap {
    position: absolute; left: 1px; width: 28px; height: 22px; border-radius: 6px;
    background: var(--raise); border: 1px solid var(--line);
    box-shadow: 0 3px 0 var(--edge), 0 6px 8px -2px rgb(0 0 0 / 0.3), inset 0 1px 0 var(--hi);
  }
  .cap::after { content: ''; position: absolute; left: 5px; right: 5px; top: 9px; height: 2px; border-radius: 1px; background: var(--ink); }
</style>
