<script lang="ts">
  import { onMount } from 'svelte';
  import { audio } from '../audio/host';
  import { capturePlugins, plug, runningPlugin } from '../plugins.svelte';
  import type { WamParam } from '../plugins/host';
  import { app } from '../state.svelte';
  import Modal from './Modal.svelte';

  const at = plug.open ?? { track: app.sel, index: 0 };
  const wam = runningPlugin(at.track, at.index);
  const name = plug.tracks[at.track]?.[at.index]?.name ?? 'Plugin';
  let holder = $state<HTMLDivElement>();
  let view = $state<'loading' | 'own' | 'sliders' | 'none' | 'gone'>(wam ? 'loading' : 'gone');
  let params = $state<(WamParam & { value: number })[]>([]);

  onMount(() => {
    if (!wam) return;
    let gui: HTMLElement | undefined, alive = true;
    void (async () => {
      // a plugin may bring its own face; one that doesn't gets a slider for each of its parameters
      try { gui = await wam.instance.createGui(); } catch { gui = undefined; }
      if (!alive) { if (gui) wam.instance.destroyGui?.(gui); return; }
      if (gui && holder) { holder.append(gui); view = 'own'; return; }
      try {
        const info = await wam.node.getParameterInfo();
        const values = await wam.node.getParameterValues(false);
        params = Object.keys(info).map((id) => ({ ...info[id], id, value: values[id]?.value ?? info[id].defaultValue }));
        view = params.length ? 'sliders' : 'none';
      } catch { view = 'none'; }
    })();
    // what is changed in here is copied into the beat as it goes, so it is saved, shared and undone with it
    const timer = setInterval(() => void capturePlugins(at.track), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
      void capturePlugins(at.track);
      if (gui) { try { wam.instance.destroyGui?.(gui); } catch { /* its own business */ } gui.remove(); }
      plug.open = null;
    };
  });

  function set(p: WamParam & { value: number }, v: number): void {
    p.value = v;
    void wam?.node.setParameterValues({ [p.id]: { id: p.id, value: v, normalized: false } });
  }
  const step = (p: WamParam) => p.discreteStep || (p.type === 'float' ? (p.maxValue - p.minValue) / 200 : 1);
  const show = (p: WamParam & { value: number }) => (p.choices?.length ? p.choices[Math.round(p.value)] ?? '' : `${p.type === 'float' ? p.value.toFixed(2) : Math.round(p.value)}${p.units ? ` ${p.units}` : ''}`);

  // a way to hear it without leaving the window
  const NOTES = [48, 52, 55, 60, 64, 67, 72];
  const names = ['C3', 'E3', 'G3', 'C4', 'E4', 'G4', 'C5'];
  const down = (p: number) => audio.noteOn(at.track, p, 100);
  const up = (p: number) => audio.noteOff(at.track, p);
</script>

<Modal title={name} wide>
  {#if view === 'gone'}
    <p class="note">This plugin isn't running. Close this and load it from the track's Sound tab.</p>
  {:else}
    <div class="face" bind:this={holder} class:own={view === 'own'}>
      {#if view === 'loading'}<p class="note" role="status">Opening…</p>{/if}
      {#if view === 'none'}<p class="note">This plugin has no controls of its own.</p>{/if}
      {#if view === 'sliders'}
        <div class="params">
          {#each params as p (p.id)}
            <label>
              <span>{p.label || p.id}</span>
              <input type="range" min={p.minValue} max={p.maxValue} step={step(p)} value={p.value} aria-label={p.label || p.id}
                oninput={(e) => set(p, +(e.currentTarget as HTMLInputElement).value)} />
              <output>{show(p)}</output>
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <div class="try" role="group" aria-label="Play a note to hear it">
      <span class="label">Try it</span>
      {#each NOTES as n, i}
        <button class="btn" aria-label="Play {names[i]}"
          onpointerdown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); down(n); }} onpointerup={() => up(n)} onpointercancel={() => up(n)}
          onkeydown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(n); }} onkeyup={(e) => { if (e.key === ' ' || e.key === 'Enter') up(n); }}>{names[i]}</button>
      {/each}
    </div>
  {/if}
</Modal>

<style>
  .face { min-height: 80px; max-width: 100%; overflow: auto; border-radius: 12px; background: var(--inset); }
  .face.own { display: grid; place-items: start center; }
  .note { margin: 0; padding: 16px; font-size: 13px; color: var(--dim); }
  .params { display: grid; gap: 12px; padding: 16px 18px; }
  label { display: grid; grid-template-columns: minmax(90px, 0.6fr) minmax(0, 1.4fr) 64px; align-items: center; gap: 12px; font-size: 13px; }
  input[type='range'] { width: 100%; accent-color: var(--accent); }
  output { font: 600 11px var(--mono); color: var(--dim); text-align: right; }
  .try { display: flex; align-items: center; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .try .btn { height: 34px; min-width: 44px; font-size: 10px; touch-action: none; }
</style>
