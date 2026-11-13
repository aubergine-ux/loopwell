<script lang="ts">
  import { MOD_LABELS, MAX_UNISON } from '../core/dsp/voices';
  import { WAVETABLES } from '../core/dsp/wavetable';
  import { noteName } from '../core/scales';
  import { LFO_DIV_LABELS, LFO_SHAPES } from '../core/types';
  import { app } from '../state.svelte';
  import * as fmt from './fmt';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  const t = $derived(app.project.tracks[app.sel]);
  const s = $derived(t.synth);
  const color = $derived(`var(--t${t.color})`);
  const WAVE_NAMES = ['Saw', 'Square', 'Triangle', 'Sine', ...WAVETABLES.map((w) => `${w.name} table`)];
  const K = 40;

  const lfoRate = (v: number) => (s.lfoSync
    ? LFO_DIV_LABELS[Math.round((v / 127) * (LFO_DIV_LABELS.length - 1))]
    : `${(0.05 * Math.pow(600, v / 127)).toFixed(v < 60 ? 2 : 1)}Hz`);
  const cents = (v: number) => `${Math.round((v / 127) * 100)}c`;
</script>

<div class="synth" style:--c={color}>
  <div class="top">
    <button class="btn" onclick={() => (app.modal = 'presets')} title="Browse sounds"><Icon name="grid" size={13} />Presets</button>
    <div class="rootnote">
      <span class="label">Root</span>
      <div class="stepper">
        <button onclick={() => (t.note = Math.max(12, t.note - 12))} aria-label="Octave down">−</button>
        <b>{noteName(t.note)}</b>
        <button onclick={() => (t.note = Math.min(96, t.note + 12))} aria-label="Octave up">+</button>
      </div>
    </div>
  </div>

  <div class="groups">
    <section>
      <h4>Osc 1</h4>
      <select class="pick" bind:value={s.wave} aria-label="Oscillator 1 wave">{#each WAVE_NAMES as w, i}<option value={i}>{w}</option>{/each}</select>
      <div class="k" class:dim={s.wave < 4}><Knob bind:value={s.pos} def={0} label="Shape" size={K} {color} /></div>
    </section>
    <section>
      <h4>Osc 2</h4>
      <select class="pick" bind:value={s.wave2} aria-label="Oscillator 2 wave">{#each WAVE_NAMES as w, i}<option value={i}>{w}</option>{/each}</select>
      <div class="k">
        <span class:dim={s.wave2 < 4}><Knob bind:value={s.pos2} def={0} label="Shape" size={K} {color} /></span>
        <Knob bind:value={s.semi2} min={-24} max={24} def={0} bipolar label="Semi" size={K} format={fmt.semis} {color} />
        <Knob bind:value={s.fine2} min={-50} max={50} def={0} bipolar label="Fine" size={K} format={fmt.semis} {color} />
      </div>
    </section>
    <section>
      <h4>Mix</h4>
      <div class="k">
        <Knob bind:value={s.mix} def={0} label="1 ↔ 2" size={K} {color} />
        <Knob bind:value={s.noise} def={0} label="Noise" size={K} {color} />
      </div>
    </section>
    <section>
      <h4>Unison</h4>
      <div class="k">
        <div class="stepper" title="Stacked voices">
          <button onclick={() => (s.uni = Math.max(1, s.uni - 1))} aria-label="Fewer unison voices">−</button>
          <b>{s.uni}</b>
          <button onclick={() => (s.uni = Math.min(MAX_UNISON, s.uni + 1))} aria-label="More unison voices">+</button>
        </div>
        <Knob bind:value={s.detune} def={9} label="Detune" size={K} format={cents} {color} />
        <Knob bind:value={s.spread} def={0} label="Width" size={K} {color} />
      </div>
    </section>
    <section>
      <h4>Filter</h4>
      <div class="k">
        <Knob bind:value={s.cutoff} def={70} label="Cutoff" size={K} {color} />
        <Knob bind:value={s.reso} def={30} label="Reso" size={K} {color} />
        <Knob bind:value={s.env} def={60} label="Env" size={K} {color} />
      </div>
    </section>
    <section>
      <h4>Amp</h4>
      <div class="k">
        <Knob bind:value={s.attack} def={0} label="Attack" size={K} {color} />
        <Knob bind:value={s.decay} def={50} label="Decay" size={K} {color} />
        <Knob bind:value={s.sustain} def={40} label="Sustain" size={K} {color} />
        <Knob bind:value={s.release} def={30} label="Release" size={K} {color} />
      </div>
    </section>
    <section>
      <h4>LFO <button class="tiny" class:on={s.lfoSync} onclick={() => (s.lfoSync = !s.lfoSync)} aria-pressed={s.lfoSync} title="Lock the LFO to the tempo">Sync</button></h4>
      <div class="pair">
        <select class="pick" bind:value={s.lfoShape} aria-label="LFO shape">{#each LFO_SHAPES as w, i}<option value={i}>{w}</option>{/each}</select>
        <select class="pick" bind:value={s.lfoDest} aria-label="LFO target">{#each MOD_LABELS as w, i}<option value={i}>→ {w}</option>{/each}</select>
      </div>
      <div class="k">
        <Knob bind:value={s.lfoRate} def={64} label="Rate" size={K} format={lfoRate} {color} />
        <Knob bind:value={s.lfoAmt} min={-64} max={63} def={0} bipolar label="Amount" size={K} {color} />
      </div>
    </section>
    <section>
      <h4>Mod env</h4>
      <select class="pick" bind:value={s.menvDest} aria-label="Mod envelope target">{#each MOD_LABELS as w, i}<option value={i}>→ {w}</option>{/each}</select>
      <div class="k">
        <Knob bind:value={s.menvAttack} def={0} label="Attack" size={K} {color} />
        <Knob bind:value={s.menvDecay} def={50} label="Decay" size={K} {color} />
        <Knob bind:value={s.menvAmt} min={-64} max={63} def={0} bipolar label="Amount" size={K} {color} />
      </div>
    </section>
  </div>
</div>

<style>
  .synth { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .top { display: flex; align-items: flex-end; gap: 14px; }
  .top .btn { height: 30px; font-size: 10px; }
  .rootnote { display: flex; flex-direction: column; gap: 3px; }
  .stepper { display: flex; align-items: center; background: var(--inset); border-radius: 8px; height: 26px; }
  .stepper button { width: 24px; height: 26px; border: 0; background: none; font: 700 14px var(--mono); color: var(--dim); }
  .stepper b { font: 700 11px var(--mono); min-width: 26px; text-align: center; }
  .groups { display: flex; flex-wrap: wrap; gap: 8px; }
  section {
    display: flex; flex-direction: column; gap: 6px; padding: 8px 9px 6px; border-radius: 12px; background: var(--inset);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.1);
  }
  h4 { margin: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; font: 700 9.5px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .k { display: flex; gap: 0; align-items: center; }
  .pair { display: flex; gap: 4px; }
  .pick { height: 24px; font-size: 10px; padding: 0 18px 0 6px; background-position: calc(100% - 11px) 10px, calc(100% - 6px) 10px; max-width: 132px; }
  .dim { opacity: 0.35; }
  .tiny {
    height: 16px; padding: 0 6px; border-radius: 5px; border: 1px solid var(--line); background: var(--raise); color: var(--dim);
    font: 700 8.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
  }
  .tiny.on { background: var(--c); color: var(--on-c); border-color: transparent; }
</style>
