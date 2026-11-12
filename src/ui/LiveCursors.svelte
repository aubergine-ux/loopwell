<script lang="ts">
  import { onMount } from 'svelte';
  import { live, setPresence, type Presence } from '../live/session.svelte';
  import { app } from '../state.svelte';

  // Other people's pointers, drawn over the instrument, and ours sent out.
  // A position is a fraction of either the upper part (transport and grid or
  // timeline) or the lower part (pads and panel), so it lands on the same
  // control for someone whose window or open panel is a different size.
  let { host }: { host: HTMLElement } = $props();
  const others = $derived(live.peers.filter((p) => p.id !== live.me && p.aw));
  let tick = $state(0); // bumped on resize so positions are worked out again

  /** The two zones as boxes inside the instrument: [top, height] each, in pixels. */
  function zones(): [number, number][] {
    const r = host.getBoundingClientRect();
    const lower = host.querySelector('.lower')?.getBoundingClientRect();
    const split = lower ? lower.top - r.top : r.height;
    return [[0, split], [split, r.height - split]];
  }

  function place(aw: Presence): { left: string; top: string; here: boolean } {
    void tick;
    const [top, height] = zones()[aw.zone ? 1 : 0];
    // someone in another view or panel is pointing at something that isn't on our screen
    const here = aw.song === app.project.songMode && (aw.zone ? aw.tab === app.tab : aw.song || aw.pat === app.pat);
    return { left: `${aw.x * 100}%`, top: `${top + aw.y * height}px`, here };
  }
  const where = (aw: Presence) => (aw.song !== app.project.songMode ? (aw.song ? ' · song' : ` · pattern ${'ABCDEFGH'[aw.pat]}`)
    : aw.zone && aw.tab !== app.tab ? ` · ${aw.tab}` : !aw.song && aw.pat !== app.pat ? ` · pattern ${'ABCDEFGH'[aw.pat]}` : '');

  onMount(() => {
    const move = (e: PointerEvent) => {
      if (!live.online) return;
      const r = host.getBoundingClientRect();
      const z = zones();
      const y = e.clientY - r.top;
      const zone = y >= z[1][0] ? 1 : 0;
      setPresence({
        x: +((e.clientX - r.left) / r.width).toFixed(4), y: +((y - z[zone][0]) / Math.max(1, z[zone][1])).toFixed(4),
        zone, tab: app.tab, song: app.project.songMode, pat: app.pat, sel: app.sel,
      });
    };
    const resized = () => tick++;
    host.addEventListener('pointermove', move, { passive: true });
    addEventListener('resize', resized);
    return () => { host.removeEventListener('pointermove', move); removeEventListener('resize', resized); };
  });
</script>

{#each others as p (p.id)}
  {@const at = place(p.aw!)}
  <div class="cursor" class:away={!at.here} style:--c="var(--t{p.color})" style:left={at.left} style:top={at.top} data-peer={p.name}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 1l11 6.5-5 1.2L5.5 14z" /></svg>
    <span>{p.name}{where(p.aw!)}</span>
  </div>
{/each}

<style>
  .cursor { position: absolute; z-index: 20; pointer-events: none; transition: left 80ms linear, top 80ms linear; }
  .cursor.away { opacity: 0.45; }
  .cursor path { fill: var(--c); stroke: #fff; stroke-width: 1; }
  .cursor span {
    position: absolute; left: 12px; top: 13px; padding: 1px 6px; border-radius: 6px; background: var(--c); color: #fff;
    font: 700 10px var(--mono); white-space: nowrap; text-shadow: 0 1px 1px rgb(0 0 0 / 0.3);
  }
</style>
