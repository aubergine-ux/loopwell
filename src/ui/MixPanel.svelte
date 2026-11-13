<script lang="ts">
  import { onMount } from 'svelte';
  import { audio } from '../audio/host';
  import { METER_CHANNELS } from '../core/engine';
  import { SILENT } from '../core/loudness';
  import { MAX_BUSES, MAX_TRACKS } from '../core/types';
  import { addBus, clearReference, listenTo, loadReference, reference, removeBus, routeTrack } from '../mix.svelte';
  import { app } from '../state.svelte';
  import { frameNo, meterScale, onFrame } from '../visual';
  import Fader from './Fader.svelte';
  import * as fmt from './fmt';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  let root: HTMLElement;
  let spectrum = $state<HTMLCanvasElement>();
  let scope = $state<HTMLCanvasElement>();
  let picker = $state<HTMLInputElement>();
  let view = $state<'spectrum' | 'wave'>('spectrum');
  const p = $derived(app.project);
  const fx = $derived(p.fx);

  const lufs = (v: number) => (v <= SILENT ? '–' : v.toFixed(1));

  onMount(() => {
    audio.setMetering(true);
    const lv = new Float32Array(MAX_TRACKS + MAX_BUSES + 4);
    const freq = new Uint8Array(1024), wave = new Uint8Array(1024);
    let frame = 0;
    // looked up once and again whenever the set of strips changes, not on every frame
    let bars: { el: HTMLElement; kind: string; k: number }[] = [];
    let readouts: HTMLElement[] = [];
    let strips = -1;
    let ink = '';
    const off = onFrame(() => {
      const count = p.tracks.length * 10 + p.buses.length;
      if (count !== strips) {
        strips = count;
        bars = [...root.querySelectorAll<HTMLElement>('.vu i')].map((el) => ({ el, kind: el.dataset.m![0], k: +el.dataset.m!.slice(1) }));
        readouts = [...root.querySelectorAll<HTMLElement>('[data-lufs]')];
      }
      frame++;
      // loudness numbers change slowly, so they are written a few times a second
      if (frame % 12 === 0) {
        const l = audio.loudness;
        for (const el of readouts) {
          const text = l ? lufs(l[+el.dataset.lufs!]) : '–';
          if (el.textContent !== text) el.textContent = text;
        }
      }
      // the level bars move on the frames the grid's don't, and the displays are drawn on the others:
      // thirty times a second each looks the same as sixty and leaves room for everything else
      if (frameNo & 1) {
        for (let i = 0; i < bars.length; i++) {
          const { el, kind, k } = bars[i];
          const src = kind === 't' ? audio.peaks[k] : kind === 'b' ? audio.busPeaks[k] : kind === 'r' ? audio.returnPeaks[k] : k ? audio.masterR : audio.masterL;
          const next = Math.max(src, lv[i] * 0.77);
          if (next === lv[i]) continue;
          const hot = next > 0.98, was = lv[i] > 0.98;
          lv[i] = next < 0.001 ? 0 : next;
          meterScale(el, Math.sqrt(lv[i]), 'Y');
          if (hot !== was) el.classList.toggle('hot', hot);
        }
      } else if (frame % 6 < 2) {
        // the displays: twenty times a second is as much as an analyser needs
        if (frame % 120 < 2 || !ink) ink = getComputedStyle(root).getPropertyValue('--accent').trim() || '#f50';
        draw(freq, wave, ink);
      }
    });
    return () => { off(); audio.setMetering(false); };
  });

  function draw(freq: Uint8Array<ArrayBuffer>, wave: Uint8Array<ArrayBuffer>, ink: string): void {
    const c = view === 'spectrum' ? spectrum : scope;
    if (!c || !c.clientWidth) return;
    // bars and a line a pixel and a half wide gain nothing from a high-density canvas, which is four times the pixels to fill
    const dpr = 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (view === 'spectrum') {
      if (!audio.spectrum(freq)) return;
      // bars spaced by pitch, 30 Hz to 18 kHz, the way ears and mixing decisions work
      const n = Math.max(24, Math.floor(w / 5));
      const hzPerBin = audio.sampleRate / 2048;
      g.fillStyle = ink;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const f0 = 30 * Math.pow(600, i / n), f1 = 30 * Math.pow(600, (i + 1) / n);
        const a = Math.max(1, Math.floor(f0 / hzPerBin)), b = Math.min(1023, Math.max(a, Math.floor(f1 / hzPerBin)));
        let v = 0;
        for (let k = a; k <= b; k++) if (freq[k] > v) v = freq[k];
        if (!v) continue;
        const bh = (v / 255) * (h - 2);
        g.rect((i / n) * w, h - bh, w / n - 1, bh);
      }
      g.fill();
    } else {
      if (!audio.scope(wave)) return;
      g.strokeStyle = ink;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 0; x < w; x += 2) {
        const y = h / 2 - ((wave[Math.floor((x / w) * wave.length)] - 128) / 128) * (h / 2 - 2);
        if (x) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    }
  }

  function pick(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = '';
    if (f) void loadReference(f);
  }
  const trim = $derived(`${reference.trim > 0 ? '+' : ''}${reference.trim.toFixed(1)} dB`);
</script>

<div class="mix" bind:this={root}>
 <div class="strips">
  {#each p.tracks as t, i (i)}
    {@const color = `var(--t${t.color})`}
    <div class="ch" class:sel={app.sel === i} style:--c={color}>
      <button class="nm" onclick={() => (app.sel = i)}>{t.name}</button>
      <div class="sends">
        <Knob bind:value={t.pan} min={-64} max={63} def={0} bipolar label="Pan" size={26} format={fmt.pan} {color} />
        <Knob bind:value={t.rev} def={0} label="Rev" size={26} {color} />
        <Knob bind:value={t.dly} def={0} label="Dly" size={26} {color} />
      </div>
      <div class="fd">
        <div class="vu"><i data-m="t{i}"></i></div>
        <Fader bind:value={t.vol} label="{t.name} level" {color} />
      </div>
      <span class="lufs" title="Loudness right now, in LUFS"><b data-lufs={i}>–</b></span>
      <div class="msrow">
        <button class="ms" class:on={t.mute} onclick={() => (t.mute = !t.mute)} aria-pressed={t.mute} aria-label="Mute {t.name}">M</button>
        <button class="ms solo" class:on={t.solo} onclick={() => (t.solo = !t.solo)} aria-pressed={t.solo} aria-label="Solo {t.name}">S</button>
      </div>
      <select class="out" value={t.bus} onchange={(e) => routeTrack(i, +e.currentTarget.value)} aria-label="Where {t.name} goes"
        title="Send this track straight to the master, or into a group with others">
        <option value={0}>→ Master</option>
        {#each p.buses as b, k}<option value={k + 1}>→ {b.name}</option>{/each}
        {#if p.buses.length < MAX_BUSES}<option value={p.buses.length + 1}>→ New group</option>{/if}
      </select>
    </div>
  {/each}

  {#each p.buses as b, k (k)}
    <div class="ch bus" class:sel={app.rackBus === k}>
      <input class="nm edit" bind:value={b.name} maxlength="12" aria-label="Name of group {k + 1}" spellcheck="false"
        oninput={(e) => (b.name = e.currentTarget.value.toUpperCase())} />
      <div class="sends info">
        <span>{p.tracks.filter((t) => t.bus === k + 1).length} tracks</span>
        <button class="btn ghost fxbtn" onclick={() => { app.rackBus = k; app.tab = 'rack'; }} title="Effects on the whole group">FX{b.fx.length ? ` · ${b.fx.length}` : ''}</button>
      </div>
      <div class="fd">
        <div class="vu"><i data-m="b{k}"></i></div>
        <Fader bind:value={b.vol} label="{b.name} level" color="var(--ink)" />
      </div>
      <span class="lufs"><b data-lufs={MAX_TRACKS + k}>–</b></span>
      <div class="msrow">
        <button class="ms" class:on={b.mute} onclick={() => (b.mute = !b.mute)} aria-pressed={b.mute} aria-label="Mute {b.name}">M</button>
        <button class="ms" onclick={() => removeBus(k)} aria-label="Remove {b.name}" title="Remove this group; its tracks go back to the master">×</button>
      </div>
      <span class="out tag">Group</span>
    </div>
  {/each}
  {#if !p.buses.length}
    <button class="ch add" onclick={addBus} title="Add a group: several tracks mixed as one, with their own fader and effects"><Icon name="plus" size={14} />Group</button>
  {/if}

  <div class="ch ret" style:--c="var(--t4)">
    <span class="nm">REVERB</span>
    <div class="sends"><Knob bind:value={fx.revSize} def={70} label="Size" size={34} color="var(--t4)" /></div>
    <div class="fd">
      <div class="vu"><i data-m="r0"></i></div>
      <Fader bind:value={fx.revLevel} def={90} label="Reverb return level" color="var(--t4)" />
    </div>
    <span class="lufs"><b data-lufs={MAX_TRACKS + MAX_BUSES}>–</b></span>
    <div class="msrow"><button class="ms" class:on={fx.revMute} onclick={() => (fx.revMute = !fx.revMute)} aria-pressed={fx.revMute} aria-label="Mute the reverb return">M</button></div>
    <span class="out tag">Return</span>
  </div>
  <div class="ch ret" style:--c="var(--t6)">
    <span class="nm">DELAY</span>
    <div class="sends"><Knob bind:value={fx.dlyFb} def={50} label="Fdbk" size={34} color="var(--t6)" /></div>
    <div class="fd">
      <div class="vu"><i data-m="r1"></i></div>
      <Fader bind:value={fx.dlyLevel} def={90} label="Delay return level" color="var(--t6)" />
    </div>
    <span class="lufs"><b data-lufs={MAX_TRACKS + MAX_BUSES + 1}>–</b></span>
    <div class="msrow"><button class="ms" class:on={fx.dlyMute} onclick={() => (fx.dlyMute = !fx.dlyMute)} aria-pressed={fx.dlyMute} aria-label="Mute the delay return">M</button></div>
    <span class="out tag">Return</span>
  </div>
 </div>

  <div class="ch master">
    <span class="nm">MASTER</span>
    <div class="fd tall">
      <div class="vu"><i data-m="m0"></i></div>
      <div class="vu"><i data-m="m1"></i></div>
      <Fader bind:value={p.master} label="Master level" color="var(--ink)" height={168} />
    </div>
  </div>

  <div class="scope">
    <div class="row">
      <div class="seg" role="radiogroup" aria-label="Master display">
        <button class:on={view === 'spectrum'} role="radio" aria-checked={view === 'spectrum'} onclick={() => (view = 'spectrum')}>Spectrum</button>
        <button class:on={view === 'wave'} role="radio" aria-checked={view === 'wave'} onclick={() => (view = 'wave')}>Wave</button>
      </div>
    </div>
    <div class="screen">
      <canvas bind:this={spectrum} class:hide={view !== 'spectrum'} aria-label="Spectrum of the master output, low frequencies on the left"></canvas>
      <canvas bind:this={scope} class:hide={view !== 'wave'} aria-label="Waveform of the master output"></canvas>
      {#if view === 'spectrum'}<span class="hz"><i>50</i><i>200</i><i>1k</i><i>5k</i><i>15k</i></span>{/if}
    </div>
    <dl title="Loudness in LUFS: right now (the last 0.4 s), short (the last 3 s), and the whole of what has played since play was pressed">
      <div><dt>Now</dt><dd data-lufs={METER_CHANNELS - 1}>–</dd></div>
      <div><dt>Short</dt><dd data-lufs={METER_CHANNELS}>–</dd></div>
      <div><dt>Whole</dt><dd data-lufs={METER_CHANNELS + 1}>–</dd></div>
      <div class="unit"><dt>&nbsp;</dt><dd>LUFS</dd></div>
    </dl>
    <div class="ref">
      {#if reference.name}
        <div class="seg ab" role="radiogroup" aria-label="Listen to">
          <button class:on={!reference.on} role="radio" aria-checked={!reference.on} onclick={() => listenTo(false)}>Mix</button>
          <button class:on={reference.on} role="radio" aria-checked={reference.on} onclick={() => listenTo(true)} title="Hear the reference at the same loudness as your mix">Reference</button>
        </div>
        <span class="refname" title="{reference.name}: {lufs(reference.lufs)} LUFS">{reference.name}</span>
        <span class="trim">{reference.on ? `matched ${trim}` : `${lufs(reference.lufs)} LUFS`}</span>
        <button class="btn ghost sq" onclick={clearReference} aria-label="Remove the reference track"><Icon name="x" size={13} /></button>
      {:else}
        <button class="btn" onclick={() => picker?.click()} disabled={reference.loading}
          title="Load a finished song and switch between it and your mix, at the same loudness, to hear how they compare">
          <Icon name="open" size={13} />{reference.loading ? 'Reading…' : 'Reference track'}</button>
      {/if}
      <input bind:this={picker} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.aif,.m4a" hidden onchange={pick} />
    </div>
  </div>
</div>

<style>
  /* the channel strips scroll sideways when there are many; the master and its displays stay put on the right */
  .mix { display: flex; gap: 6px; min-width: 0; }
  .strips { flex: 1 1 0; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
  .ch {
    flex: 1 1 0; min-width: 88px; display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 8px 6px 8px; border-radius: 12px; background: var(--inset);
    border-top: 3px solid var(--c);
  }
  .ch.sel { box-shadow: 0 0 0 2px var(--c) inset; }
  .ch.bus { --c: var(--ink); flex: 0 0 90px; }
  .ch.ret { flex: 0 0 78px; min-width: 78px; }
  .ch.master { border-top-color: var(--ink); flex: 0 0 78px; min-width: 78px; }
  .ch.add {
    flex: 0 0 60px; min-width: 60px; justify-content: center; gap: 4px; border: 1px dashed var(--line); background: none; color: var(--dim);
    font: 700 10px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
  }
  .ch.add:hover { color: var(--ink); border-color: var(--dim); }
  .nm {
    border: 0; background: none; padding: 0; max-width: 100%;
    font: 700 10px var(--mono); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .nm.edit { width: 100%; text-align: center; text-transform: uppercase; user-select: text; -webkit-user-select: text; border-radius: 4px; }
  .nm.edit:focus { outline: 1px solid var(--dim); }
  .sends { display: flex; min-height: 53px; }
  .sends :global(.knob) { min-width: 0; padding: 0; }
  .sends :global(.label) { font-size: 8px; }
  .sends.info { flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 600 9px var(--mono); color: var(--dim); }
  .fxbtn { height: 22px; padding: 0 8px; font-size: 9px; border: 1px solid var(--line); }
  .fd { display: flex; gap: 6px; align-items: stretch; }
  .fd.tall { flex: 1; align-items: flex-end; }
  .vu { width: 5px; border-radius: 3px; background: var(--well); overflow: hidden; display: flex; align-items: flex-end; }
  .vu i { display: block; width: 100%; height: 100%; background: var(--c, var(--ink)); transform-origin: bottom; transform: scaleY(0); will-change: transform; }
  .vu :global(i.hot) { background: var(--rec); }
  .lufs { font: 600 9px var(--mono); color: var(--dim); min-width: 34px; text-align: center; }
  .lufs b { font-weight: 700; color: var(--ink); }
  .msrow { display: flex; gap: 4px; }
  .ms {
    width: 26px; height: 22px; padding: 0; border-radius: 6px; border: 1px solid var(--line); background: var(--raise);
    color: var(--dim); font: 700 10px var(--mono);
  }
  .ms.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .ms.solo.on { background: var(--t2); color: #221a00; }
  .out {
    width: 100%; height: 18px; border: 0; border-radius: 5px; background: var(--well); color: var(--dim);
    font: 600 8.5px var(--mono); text-align: center; padding: 0 2px;
  }
  .out.tag { display: grid; place-items: center; background: none; letter-spacing: 0.1em; text-transform: uppercase; }

  .scope { flex: 0 0 236px; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px; border-radius: 12px; background: var(--inset); border-top: 3px solid var(--ink); }
  .row { display: flex; align-items: center; gap: 8px; }
  .seg button { min-width: 0; padding: 0 8px; font-size: 10px; }
  .screen { position: relative; flex: 1; min-height: 84px; border-radius: 8px; background: var(--well); overflow: hidden; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  canvas.hide { display: none; }
  .hz { position: absolute; left: 0; right: 0; bottom: 1px; font: 600 7.5px var(--mono); color: var(--dim); pointer-events: none; }
  .hz i { position: absolute; bottom: 0; font-style: normal; transform: translateX(-50%); opacity: 0.8; }
  .hz i:nth-child(1) { left: 8%; } .hz i:nth-child(2) { left: 29.7%; } .hz i:nth-child(3) { left: 54.8%; } .hz i:nth-child(4) { left: 80%; } .hz i:nth-child(5) { left: 97%; }
  dl { display: grid; grid-template-columns: repeat(3, 1fr) auto; gap: 4px; margin: 0; }
  dl div { padding: 3px 6px; border-radius: 6px; background: var(--well); }
  dl .unit { background: none; padding: 3px 0 3px 2px; }
  dt { font: 700 7.5px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  dd { margin: 0; font: 700 12px var(--mono); }
  .unit dd { font-size: 8px; color: var(--dim); line-height: 15px; }
  .ref { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 28px; }
  .ref .btn { height: 28px; font-size: 10px; gap: 5px; }
  .ref .btn.sq { width: 24px; height: 24px; }
  .refname { flex: 1; min-width: 40px; font: 700 10px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trim { font: 600 9px var(--mono); color: var(--dim); white-space: nowrap; }
  .ab { flex: none; }
  @media (max-width: 900px) {
    .mix { flex-wrap: wrap; }
    .strips { flex-basis: 100%; }
    .scope { flex: 1 1 200px; }
  }
</style>
