<script lang="ts">
  import { setStep, stepVel, toast } from '../actions.svelte';
  import {
    SOUND_PARTS, SOUND_PART_LABELS, applyEuclid, randomizePattern, randomizeSound, randomizeTrack, setFill, setStepMod, stepMod, type SoundPart,
  } from '../creative.svelte';
  import { cancelTap, finishTap, ideas, startTap, tap } from '../ideas.svelte';
  import { CHANCES, CONDITIONS, GROOVES, MAX_RATCHET, euclid, modChance, modCond, modRatchet } from '../core/creative';
  import { DEFAULT_VEL, usesNotes } from '../core/types';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';

  const p = $derived(app.project);
  const t = $derived(p.tracks[app.sel]);
  const color = $derived(`var(--t${t.color})`);

  // --- the selected step ---
  const step = $derived(app.step && app.step.t === app.sel && app.step.s < p.steps ? app.step.s : -1);
  const on = $derived(step >= 0 && stepVel(app.sel, step) > 0);
  const m = $derived(step >= 0 ? stepMod(app.sel, step) : 0);
  function edit(part: { ratchet?: number; chance?: number; cond?: number }): void {
    if (step < 0) return;
    if (!on) setStep(app.sel, step, DEFAULT_VEL);
    setStepMod(app.sel, step, part);
  }

  // --- Euclid ---
  let eSteps = $state(16), ePulses = $state(5), eRot = $state(0);
  const cycle = $derived(euclid(eSteps, Math.min(ePulses, eSteps), eRot));
  $effect(() => { if (ePulses > eSteps) ePulses = eSteps; });

  // --- dice ---
  let keep = $state<'none' | 'rhythm' | 'pitch'>('none');
  let soundLocks = $state<Partial<Record<SoundPart, boolean>>>({});
  // which parts of the sound can be held still depends on what makes it
  const PARTS: Record<string, [SoundPart, string][]> = {
    synth: SOUND_PARTS.map((k) => [k, SOUND_PART_LABELS[k]]),
    drum: [['osc', 'Sample'], ['env', 'Tune & decay'], ['filter', 'Filter']],
    slice: [],
    bass: [['osc', 'Saturation'], ['env', 'Body'], ['mod', 'Slide']],
    dsyn: [['osc', 'Character'], ['env', 'Tune & decay']],
  };
  const parts = $derived(PARTS[t.kind]);
  const lockedCount = $derived(p.tracks.filter((_, i) => app.locks[i]).length);
  function rollPattern(): void {
    if (!randomizePattern()) toast('Every track is locked, so there is nothing to roll.');
  }
</script>

<div class="tools" style:--c={color}>
  <section>
    <h3>Step <small>{step >= 0 ? `${t.name} · ${step + 1}` : ''}</small></h3>
    {#if step < 0}
      <p>Right-click a step in the grid (or press and hold it) to give it a chance, a condition or a roll.</p>
    {:else}
      <label class="field"><span class="label">Chance</span>
        <select class="pick" value={modChance(m)} onchange={(e) => edit({ chance: +e.currentTarget.value })} aria-label="Chance this step plays">
          {#each CHANCES as c, i}<option value={i}>{c}%</option>{/each}
        </select>
      </label>
      <label class="field"><span class="label">Plays</span>
        <select class="pick" value={modCond(m)} onchange={(e) => edit({ cond: +e.currentTarget.value })} aria-label="When this step plays">
          {#each CONDITIONS as c, i}<option value={i}>{c}</option>{/each}
        </select>
      </label>
      <div class="field"><span class="label">Roll</span>
        <div class="seg" role="group" aria-label="Hits inside this step">
          {#each { length: MAX_RATCHET } as _, i}
            <button class:on={modRatchet(m) === i + 1} aria-pressed={modRatchet(m) === i + 1} onclick={() => edit({ ratchet: i + 1 })}
              title={i ? `${i + 1} hits inside the step` : 'One hit'}>{i ? `×${i + 1}` : 'Off'}</button>
          {/each}
        </div>
      </div>
    {/if}
    <button class="btn fill" class:on={app.fill} aria-pressed={app.fill} title="Hold to play the steps marked “Fill only” (hold \)"
      onpointerdown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setFill(true); }}
      onpointerup={() => setFill(false)} onpointercancel={() => setFill(false)}
      onkeydown={(e) => { if (e.key === 'Enter' && !e.repeat) setFill(true); }} onkeyup={(e) => { if (e.key === 'Enter') setFill(false); }}
      onblur={() => setFill(false)}>Hold for fill</button>
  </section>

  <section>
    <h3>Euclid <small>{t.name}</small></h3>
    <div class="ring" aria-hidden="true">
      {#each cycle as hit}<i class:hit></i>{/each}
    </div>
    <div class="k">
      <Knob bind:value={eSteps} min={2} max={p.steps} def={16} label="Steps" size={40} {color} />
      <Knob bind:value={ePulses} min={0} max={eSteps} def={5} label="Hits" size={40} {color} />
      <Knob bind:value={eRot} min={0} max={Math.max(1, eSteps - 1)} def={0} label="Turn" size={40} {color} />
      <button class="btn" onclick={() => applyEuclid(app.sel, eSteps, ePulses, eRot)}
        title="Spread the hits evenly over the steps and write them to {t.name}">Apply</button>
    </div>
  </section>

  <section>
    <h3>Tap <small>{t.name}</small></h3>
    {#if usesNotes(t.kind)}
      <p>Tapping writes hits on steps, so it is for drum tracks. Pick one, or hum a melody for this track in Keys.</p>
    {:else if ideas.tapping}
      <button class="tap on" onpointerdown={(e) => { e.preventDefault(); tap(); }} onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); tap(); } }}
        aria-label="Tap the rhythm here">{ideas.tapping.count ? `${ideas.tapping.count} tap${ideas.tapping.count === 1 ? '' : 's'}` : 'Tap here'}</button>
      <div class="row">
        <button class="btn" onclick={finishTap} disabled={!ideas.tapping.count}>Done</button>
        <button class="btn ghost" onclick={cancelTap}>Cancel</button>
      </div>
      <p>Tap here, on a pad, or with the number keys. It finishes by itself when you stop.</p>
    {:else}
      <button class="tap" onclick={() => startTap(app.sel)} title="Tap a rhythm and it becomes this track's pattern">Tap a rhythm</button>
      <label class="check"><input type="checkbox" bind:checked={ideas.tapTempo} /> Set the tempo from my taps</label>
      <p>The first tap is step 1. {ideas.tapTempo ? 'The song takes the tempo you tap at.' : `Taps are read at ${p.bpm} bpm.`}</p>
    {/if}
  </section>

  <section>
    <h3>Groove</h3>
    <label class="field"><span class="label">Song</span>
      <select class="pick" bind:value={p.groove} aria-label="Groove for the whole song" title={GROOVES[p.groove].blurb}>
        {#each GROOVES as g, i}<option value={i}>{g.name}</option>{/each}
      </select>
    </label>
    <label class="field"><span class="label">{t.name}</span>
      <select class="pick" bind:value={t.groove} aria-label="Groove for {t.name}" title={t.groove ? GROOVES[t.groove].blurb : 'This track plays with the song\'s groove'}>
        <option value={0}>Same as song</option>
        {#each GROOVES.slice(1) as g, i}<option value={i + 1}>{g.name}</option>{/each}
      </select>
    </label>
    <div class="k">
      <span class:dim={!p.groove}><Knob bind:value={p.grooveAmt} max={100} def={50} label="Song amt" size={40} format={(v) => `${v}%`} /></span>
      <span class:dim={!t.groove}><Knob bind:value={t.grooveAmt} max={100} def={50} label="Track amt" size={40} format={(v) => `${v}%`} {color} /></span>
    </div>
  </section>

  <section>
    <h3>Dice <small>{lockedCount ? `${lockedCount} locked` : ''}</small></h3>
    <div class="locks" role="group" aria-label="Tracks the dice leave alone">
      {#each p.tracks as tr, i}
        <button class:on={app.locks[i]} aria-pressed={!!app.locks[i]} style:--c="var(--t{tr.color})" onclick={() => (app.locks[i] = !app.locks[i])}
          title="{app.locks[i] ? 'Locked: the dice leave' : 'Lock'} {tr.name}{app.locks[i] ? ' alone' : ''}" aria-label="Lock {tr.name}">
          {#if app.locks[i]}<Icon name="lock" size={11} />{:else}{i + 1}{/if}
        </button>
      {/each}
    </div>
    <div class="row">
      <button class="btn" onclick={rollPattern} title="A new part for every track that isn't locked"><Icon name="dice" size={13} />Pattern</button>
      <button class="btn" onclick={() => randomizeTrack(app.sel, keep)} title="A new part for {t.name} only"><Icon name="dice" size={13} />{t.name}</button>
    </div>
    {#if usesNotes(t.kind)}
      <div class="seg" role="group" aria-label="What to keep when rolling notes">
        <button class:on={keep === 'none'} onclick={() => (keep = 'none')}>All new</button>
        <button class:on={keep === 'rhythm'} onclick={() => (keep = 'rhythm')} title="Keep where the notes are, roll new pitches">Keep rhythm</button>
        <button class:on={keep === 'pitch'} onclick={() => (keep = 'pitch')} title="Keep the pitches, roll a new rhythm">Keep notes</button>
      </div>
    {/if}
    <div class="row">
      <button class="btn" onclick={() => randomizeSound(app.sel, soundLocks)} disabled={t.kind === 'slice'}
        title="A new sound for {t.name}, leaving the locked parts alone"><Icon name="dice" size={13} />Sound</button>
      {#each parts as [k, label]}
        <button class="chip" class:on={soundLocks[k]} aria-pressed={!!soundLocks[k]} onclick={() => (soundLocks[k] = !soundLocks[k])}
          title="{soundLocks[k] ? 'Kept' : 'Keep'}: {label}">{#if soundLocks[k]}<Icon name="lock" size={10} />{/if}{label}</button>
      {/each}
    </div>
  </section>
</div>

<style>
  .tools { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .tap {
    height: 54px; border-radius: 12px; border: 1px solid var(--line); background: var(--raise); font: 700 12px var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
    box-shadow: 0 3px 0 var(--edge), inset 0 1px 0 var(--hi); touch-action: none;
  }
  .tap:active { transform: translateY(3px); box-shadow: none; }
  .tap.on { background: var(--c); color: var(--on-c); border-color: transparent; }
  .check { display: flex; align-items: center; gap: 6px; font: 600 10px var(--mono); color: var(--dim); }
  section {
    display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px;
    background: var(--inset); border-top: 3px solid var(--c); min-height: 170px; min-width: 0;
  }
  h3 { margin: 0; font: 700 12px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  h3 small { font: 600 10px var(--mono); color: var(--dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  p { margin: 0; font-size: 12px; color: var(--dim); line-height: 1.4; }
  .field { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .field .label { flex: 0 0 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field .pick { flex: 1; min-width: 0; height: 26px; font-size: 11px; }
  .seg { align-self: flex-start; flex-wrap: wrap; }
  .seg button { min-width: 0; padding: 0 7px; font-size: 10px; }
  .k { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 2px; margin-top: auto; }
  .k .btn { margin: 0 0 6px auto; height: 30px; }
  .dim { opacity: 0.4; }
  .fill { margin-top: auto; align-self: flex-start; height: 30px; touch-action: none; }
  .ring { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; height: 16px; }
  .ring i { border-radius: 3px; background: var(--well); }
  .ring i.hit { background: var(--c); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row .btn { height: 28px; padding: 0 9px; gap: 5px; font-size: 11px; max-width: 100%; overflow: hidden; }
  .locks { display: flex; gap: 3px; }
  .locks button {
    flex: 1; max-width: 26px; height: 20px; padding: 0; border: 0; border-radius: 5px; display: grid; place-items: center;
    background: color-mix(in srgb, var(--c) 30%, var(--well)); color: var(--ink); font: 700 9px var(--mono);
  }
  .locks button.on { background: var(--ink); color: var(--panel); }
  .chip {
    display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 7px; border-radius: 11px; border: 1px solid var(--line);
    background: transparent; color: var(--dim); font: 600 10px var(--mono);
  }
  .chip.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  @media (max-width: 1180px) { .tools { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .tools { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 520px) { .tools { grid-template-columns: minmax(0, 1fr); } section { min-height: 0; } }
</style>
