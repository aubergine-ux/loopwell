<script lang="ts">
  import { auditionNote, padDown, padUp } from '../actions.svelte';
  import { DRUM_MODELS } from '../core/dsp/instruments';
  import { NOTE_NAMES, noteName } from '../core/scales';
  import { DRUM_DEFAULTS } from '../core/types';
  import { app } from '../state.svelte';
  import * as fmt from './fmt';
  import Knob from './Knob.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const b = $derived(t.bass);
  const d = $derived(t.dsyn);
  const color = $derived(`var(--t${t.color})`);

  // what the last two knobs do changes with the drum
  const TONE = ['Drive', 'Bright', 'Bright', 'Pitch'];
  const SNAP = ['Punch', 'Wires', 'Hiss', 'Spread'];
  const BLURB = [
    'A sine that drops from a click to a thump. Punch is how hard it drops.',
    'Two short tones for the shell and noise for the wires.',
    'Six clashing square waves with the lows taken out. Short for closed, long for open.',
    'A few bursts of noise close together, then a tail.',
  ];

  function setModel(m: number): void {
    const named = t.name === DRUM_MODELS[d.model].toUpperCase() || t.name === 'DRUM';
    t.dsyn = { model: m, ...DRUM_DEFAULTS[m] };
    if (named) t.name = DRUM_MODELS[m].toUpperCase();
    padDown(app.sel);
    padUp(app.sel);
  }

  const seconds = (v: number) => { const s = 0.12 * Math.pow(60, v / 127); return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(1)}s`; };
  const glide = (v: number) => (v ? `${Math.round(10 * Math.pow(60, v / 127))}ms` : 'Off');
  /** How far the part is moved right now to follow the key. */
  const shift = $derived(b.follow ? ((p.scaleRoot - b.key + 18) % 12) - 6 : 0);
  function follow(): void {
    // switching it on means "this part is right for the key the song is in now"
    if (!b.follow) b.key = p.scaleRoot;
    b.follow = !b.follow;
  }
</script>

{#if t.kind === 'bass'}
  <div class="inst" style:--c={color}>
    <div class="top">
      <div class="rootnote">
        <span class="label">Root</span>
        <div class="stepper">
          <button onclick={() => { t.note = Math.max(12, t.note - 12); auditionNote(app.sel, t.note); }} aria-label="Octave down">−</button>
          <b>{noteName(t.note + shift)}</b>
          <button onclick={() => { t.note = Math.min(72, t.note + 12); auditionNote(app.sel, t.note); }} aria-label="Octave up">+</button>
        </div>
      </div>
      <button class="btn" class:on={b.follow} aria-pressed={b.follow} onclick={follow}
        title="Follow the song's key: change the key and the whole bass line moves with it">Follows key · {NOTE_NAMES[p.scaleRoot]}</button>
      {#if shift}<span class="note">moved {shift > 0 ? '+' : ''}{shift} from {NOTE_NAMES[b.key]}</span>{/if}
    </div>
    <div class="groups">
      <section>
        <h4>Body</h4>
        <div class="k">
          <Knob bind:value={b.decay} def={90} label="Decay" format={seconds} {color} />
          <Knob bind:value={b.punch} def={40} label="Punch" {color} />
        </div>
      </section>
      <section>
        <h4>Saturation</h4>
        <div class="k">
          <Knob bind:value={b.drive} def={45} label="Drive" {color} />
          <Knob bind:value={b.tone} def={50} label="Tone" {color} />
        </div>
      </section>
      <section>
        <h4>Slide</h4>
        <div class="k"><Knob bind:value={b.glide} def={40} label="Glide" format={glide} {color} /></div>
      </section>
      <p>One voice, like the real thing. Make a note overlap the next one in <button class="link" onclick={() => (app.tab = 'keys')}>Keys</button> and the pitch slides instead of starting again.</p>
    </div>
  </div>
{:else}
  <div class="inst" style:--c={color}>
    <div class="top">
      <div class="seg" role="group" aria-label="Drum">
        {#each DRUM_MODELS as m, i}<button class:on={d.model === i} aria-pressed={d.model === i} onclick={() => setModel(i)}>{m}</button>{/each}
      </div>
    </div>
    <div class="groups">
      <section>
        <h4>{DRUM_MODELS[d.model]}</h4>
        <div class="k">
          <Knob bind:value={d.tune} min={-24} max={24} def={0} bipolar label="Tune" format={fmt.semis} {color} />
          <Knob bind:value={d.decay} def={DRUM_DEFAULTS[d.model].decay} label="Decay" {color} />
          <Knob bind:value={d.tone} def={DRUM_DEFAULTS[d.model].tone} label={TONE[d.model]} {color} />
          <Knob bind:value={d.snap} def={DRUM_DEFAULTS[d.model].snap} label={SNAP[d.model]} {color} />
        </div>
      </section>
      <p>{BLURB[d.model]} No sample: every hit is made from these knobs, so they can be automated on the timeline.</p>
    </div>
  </div>
{/if}

<style>
  .inst { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .top { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
  .top .btn { height: 30px; font-size: 10px; }
  .note { font: 600 10px var(--mono); color: var(--dim); align-self: center; }
  .rootnote { display: flex; flex-direction: column; gap: 3px; }
  .stepper { display: flex; align-items: center; background: var(--inset); border-radius: 8px; height: 26px; }
  .stepper button { width: 24px; height: 26px; border: 0; background: none; font: 700 14px var(--mono); color: var(--dim); }
  .stepper b { font: 700 11px var(--mono); min-width: 30px; text-align: center; }
  .groups { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
  section {
    display: flex; flex-direction: column; gap: 6px; padding: 8px 9px 6px; border-radius: 12px; background: var(--inset);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.1);
  }
  h4 { margin: 0; font: 700 9.5px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .k { display: flex; gap: 0; align-items: center; }
  p { flex: 1 1 200px; max-width: 320px; margin: 0; font-size: 12px; line-height: 1.4; color: var(--dim); }
  .link { border: 0; padding: 0; background: none; color: var(--ink); font: inherit; text-decoration: underline; }
</style>
