<script lang="ts">
  import { clamp } from '../core/types';

  interface Props {
    value: number;
    min?: number;
    max?: number;
    def?: number;
    label: string;
    size?: number;
    bipolar?: boolean;
    color?: string;
    format?: (v: number) => string;
  }
  let {
    value = $bindable(), min = 0, max = 127, def = 0, label, size = 46, bipolar = false,
    color = 'var(--accent)', format = (v: number) => String(v),
  }: Props = $props();

  let active = $state(false);
  let startY = 0, startV = 0, hideTimer = 0;

  const R = 19;
  const frac = $derived((value - min) / (max - min));
  const angle = $derived(-135 + frac * 270);

  function point(deg: number): string {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(24 + R * Math.cos(a)).toFixed(2)} ${(24 + R * Math.sin(a)).toFixed(2)}`;
  }
  function arc(from: number, to: number): string {
    if (from > to) [from, to] = [to, from];
    if (to - from < 0.5) return '';
    return `M${point(from)}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${point(to)}`;
  }

  function set(v: number): void {
    v = Math.round(clamp(v, min, max));
    if (v !== value) value = v;
  }
  function show(): void {
    active = true;
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => (active = false), 900);
  }

  function down(e: PointerEvent): void {
    if (e.button) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startY = e.clientY;
    startV = value;
    active = true;
    clearTimeout(hideTimer);
  }
  function move(e: PointerEvent): void {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const perPx = (max - min) / (e.shiftKey ? 600 : 150);
    set(startV + (startY - e.clientY) * perPx);
  }
  function up(): void {
    hideTimer = window.setTimeout(() => (active = false), 500);
  }
  function key(e: KeyboardEvent): void {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value + step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value - step);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else if (e.key === 'Delete' || e.key === 'Backspace') set(def);
    else return;
    show();
    e.preventDefault();
    e.stopPropagation();
  }
  // wheel listeners are passive by default, and this one has to stop the page scrolling
  function wheel(node: HTMLElement) {
    const fn = (e: WheelEvent) => {
      e.preventDefault();
      set(value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 8 : 2));
      show();
    };
    node.addEventListener('wheel', fn, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', fn) };
  }
</script>

<div class="knob" class:active role="slider" tabindex="0" aria-label={label} aria-valuemin={min} aria-valuemax={max}
  aria-valuenow={value} aria-valuetext={format(value)} title="Drag up or down. Double-click to reset."
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}
  ondblclick={() => { set(def); show(); }} onkeydown={key} use:wheel>
  <svg viewBox="0 0 48 48" width={size} height={size}>
    <path class="track" d={arc(-135, 135)} />
    <path class="val" d={arc(bipolar ? 0 : -135, angle)} style:stroke={color} />
    <g style:transform="rotate({angle}deg)" class="cap">
      <circle cx="24" cy="24" r="13.500" />
      <line x1="24" y1="12.500" x2="24" y2="18.500" />
    </g>
  </svg>
  <span class="label">{active ? format(value) : label}</span>
</div>

<style>
  .knob {
    display: inline-flex; flex-direction: column; align-items: center; gap: 3px;
    cursor: ns-resize; touch-action: none; border-radius: 8px; padding: 2px 3px;
    min-width: 52px;
  }
  svg { display: block; overflow: visible; }
  path { fill: none; stroke-width: 3.500; stroke-linecap: round; }
  .track { stroke: var(--well); }
  .cap { transform-origin: 24px 24px; }
  .cap circle {
    fill: var(--raise); stroke: var(--line); stroke-width: 1;
    filter: drop-shadow(0 2px 1.500px rgb(0 0 0 / 0.28));
  }
  .cap line { stroke: var(--ink); stroke-width: 2.500; stroke-linecap: round; }
  .knob.active .label { color: var(--ink); }
  .knob:hover .cap circle { stroke: var(--dim); }
</style>
