<script lang="ts">
  import { onMount } from 'svelte';
  import { prefs } from '../prefs.svelte';

  // Tooltips. Every control already says what it does in its `title`; this shows that text
  // promptly, in the app's own style, on hover or keyboard focus. With tooltips switched off
  // it shows nothing and keeps the browser's own tooltip from appearing as well.
  let text = $state('');
  let x = $state(0), y = $state(0), below = $state(true);
  let bubble = $state<HTMLElement>();
  let target: HTMLElement | null = null;
  let timer = 0;

  /** Give the element its title back and take the bubble away. */
  function hide(): void {
    clearTimeout(timer);
    if (target?.dataset.tip !== undefined) {
      target.setAttribute('title', target.dataset.tip);
      delete target.dataset.tip;
    }
    target = null;
    text = '';
  }

  function show(el: HTMLElement): void {
    const tip = el.getAttribute('title');
    if (!tip || !el.isConnected) return;
    // the browser would show its own tooltip from `title`, so it is set aside while ours is up
    el.dataset.tip = tip;
    el.removeAttribute('title');
    if (!prefs.tips) return;
    const r = el.getBoundingClientRect();
    below = r.bottom + 60 < innerHeight;
    x = Math.min(innerWidth - 12, Math.max(12, r.left + r.width / 2));
    y = below ? r.bottom + 8 : r.top - 8;
    text = tip;
  }

  function aim(el: Element | null, delay: number): void {
    const next = el?.closest<HTMLElement>('[title]') ?? null;
    if (next === target) return;
    hide();
    if (!next) return;
    target = next;
    timer = window.setTimeout(() => { if (target === next) show(next); }, delay);
  }

  onMount(() => {
    const over = (e: PointerEvent) => { if (e.pointerType === 'mouse') aim(e.target as Element, 550); };
    const out = (e: PointerEvent) => { if (target && !target.contains(e.relatedTarget as Node | null)) queueMicrotask(hide); };
    // keyboard focus only: a click also focuses, and a tooltip then would just be in the way
    const focus = (e: FocusEvent) => { const el = e.target as Element; if (el.matches?.(':focus-visible')) aim(el, 350); };
    // focus is lost in the middle of a redraw when the focused control is taken off the screen; wait until the redraw is over
    // By then the next control may already have asked for its own (browsers differ on which comes first), so only
    // the bubble that belonged to the control being left is taken away.
    const leave = () => { const was = target; queueMicrotask(() => { if (target === was) hide(); }); };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener('pointerover', over, opts);
    document.addEventListener('pointerout', out, opts);
    document.addEventListener('pointerdown', hide, opts);
    document.addEventListener('keydown', hide, opts);
    document.addEventListener('focusin', focus, opts);
    document.addEventListener('focusout', leave, opts);
    addEventListener('scroll', hide, opts);
    return () => {
      hide();
      document.removeEventListener('pointerover', over, opts);
      document.removeEventListener('pointerout', out, opts);
      document.removeEventListener('pointerdown', hide, opts);
      document.removeEventListener('keydown', hide, opts);
      document.removeEventListener('focusin', focus, opts);
      document.removeEventListener('focusout', leave, opts);
      removeEventListener('scroll', hide, opts);
    };
  });

  // keep the bubble on screen when its control is near an edge
  const shift = $derived.by(() => {
    const w = bubble?.offsetWidth ?? 0;
    if (!text || !w) return 0;
    return Math.max(8 + w / 2 - x, Math.min(0, innerWidth - 8 - w / 2 - x));
  });
</script>

{#if text}
  <div class="tip" class:below bind:this={bubble} role="tooltip" style:left="{x + shift}px" style:top="{y}px">{text}</div>
{/if}

<style>
  .tip {
    position: fixed; z-index: 95; max-width: 260px; padding: 7px 10px; border-radius: 9px; pointer-events: none;
    background: var(--ink); color: var(--panel); font-size: 12px; line-height: 1.35; font-weight: 500;
    box-shadow: 0 10px 24px -8px rgb(0 0 0 / 0.5); transform: translate(-50%, -100%);
    animation: tip 0.12s ease-out;
  }
  .tip.below { transform: translate(-50%, 0); }
  @keyframes tip { from { opacity: 0; } }
</style>
