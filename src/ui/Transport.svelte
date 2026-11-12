<script lang="ts">
  import { onMount } from 'svelte';
  import { cycleTheme, redo, selectPattern, setSteps, setView, togglePlay, undo } from '../actions.svelte';
  import { PATTERN_NAMES } from '../core/types';
  import { connectMidi } from '../audio/midi-in';
  import { community } from '../community/store.svelte';
  import { app, THEMES } from '../state.svelte';
  import { onFlash, onFrame } from '../visual';
  import Icon from './Icon.svelte';
  import Knob from './Knob.svelte';
  import Lcd from './Lcd.svelte';

  let ring: HTMLElement;
  let midiLed: HTMLElement;
  const p = $derived(app.project);

  onMount(() => {
    const offFrame = onFrame((head, changed) => {
      // the logo ring kicks on every beat, harder on the downbeat
      if (head && changed && (head.step & 3) === 0) {
        ring.animate(
          [{ transform: `scale(${head.step === 0 ? 1.35 : 1.18})` }, { transform: 'scale(1)' }],
          { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1)' },
        );
      }
    });
    const offFlash = onFlash(() => {
      if (app.midi.state === 'on') midiLed?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
    });
    return () => { offFrame(); offFlash(); };
  });

  function midiClick(): void {
    if (app.midi.state === 'on') app.modal = 'help';
    else void connectMidi().then(() => { if (app.midi.state !== 'on') app.modal = 'help'; });
  }
  const themeName = $derived(THEMES.find((t) => t.id === app.theme)?.name ?? '');
</script>

<header class="top">
  <div class="strip">
    <div class="brand" title="Loopwell">
      <span class="ring" bind:this={ring}><i></i></span>
      <span class="word">loopwell</span>
    </div>
    <div class="tools">
      <button class="btn ghost sq" onclick={undo} disabled={!app.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
      <button class="btn ghost sq" onclick={redo} disabled={!app.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
      <span class="sep"></span>
      <button class="btn ghost" onclick={() => (app.modal = 'demos')} title="Demo beats and new beat"><Icon name="grid" /><span>Beats</span></button>
      <button class="btn ghost" class:live={!!community.me} onclick={() => (app.modal = 'community')}
        title={community.server ? 'Gallery, cloud saves and sample packs' : 'Connect to a Loopwell server for a gallery, cloud saves and sample packs'}><Icon name="note" /><span>Community</span></button>
      <button class="btn ghost" onclick={() => (app.modal = 'export')} title="Export WAV, stems, MIDI or a project file"><Icon name="download" /><span>Export</span></button>
      <button class="btn ghost sq midi" class:live={app.midi.state === 'on'} onclick={midiClick} aria-label="MIDI"
        title={app.midi.state === 'on' ? `MIDI: ${app.midi.inputs.join(', ') || 'no devices connected'}` : 'Connect MIDI controllers'}>
        <Icon name="midi" /><i bind:this={midiLed}></i>
      </button>
      <button class="btn ghost sq" onclick={cycleTheme} aria-label="Change colour theme" title="Theme: {themeName} (Shift+C)"><Icon name="theme" /></button>
      <button class="btn ghost sq" onclick={() => (app.modal = 'help')} aria-label="Shortcuts and help" title="Shortcuts and help (?)"><Icon name="help" /></button>
      <button class="btn on share" onclick={() => (app.modal = 'share')}><Icon name="share" /><span>Share</span></button>
    </div>
  </div>
  <div class="deck">
    <div class="transport">
      <button class="tbtn play" class:on={app.playing} onclick={togglePlay} aria-label={app.playing ? 'Stop' : 'Play'} title="Play / stop (Space)">
        <Icon name={app.playing ? 'stop' : 'play'} size={20} fill />
      </button>
      <button class="tbtn rec" class:on={app.rec} onclick={() => (app.rec = !app.rec)} aria-label="Record" aria-pressed={app.rec}
        title="Record what you play into the pattern (R)">
        <i></i>
      </button>
    </div>

    <div class="lcdwrap"><Lcd /></div>

    <div class="knobs">
      <Knob bind:value={p.swing} max={100} def={0} label="Swing" format={(v) => `${Math.round(50 + v / 4)}%`} />
      <Knob bind:value={p.master} def={100} label="Volume" />
    </div>

    <div class="group">
      <span class="label">Steps</span>
      <div class="seg">
        <button class:on={p.steps === 16} onclick={() => setSteps(16)}>16</button>
        <button class:on={p.steps === 32} onclick={() => setSteps(32)}>32</button>
      </div>
    </div>

    <div class="group">
      <span class="label">Pattern</span>
      <div class="pats">
        {#each PATTERN_NAMES as name, i}
          <button class="btn sq pat" class:on={app.pat === i} class:queued={app.queued === i} onclick={() => selectPattern(i)}
            aria-pressed={app.pat === i} title="Pattern {name}">{name}</button>
        {/each}
      </div>
    </div>

    <div class="group">
      <span class="label">View</span>
      <div class="seg view">
        <button class:on={!p.songMode} onclick={() => setView(false)} aria-pressed={!p.songMode} title="Build loops: the pattern on screen plays round and round (V)">Pattern</button>
        <button class:on={p.songMode} onclick={() => setView(true)} aria-pressed={p.songMode} title="Arrange patterns on the timeline and play the song (V)">Song</button>
      </div>
    </div>
  </div>
</header>

<style>
  .top { border-bottom: 1px solid var(--line); }
  .strip { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px 0; }
  .deck { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding: 12px 18px 16px; }
  .brand { display: flex; align-items: center; gap: 9px; }
  .ring {
    width: 26px; height: 26px; border-radius: 50%;
    border: 5px solid var(--ink); border-top-color: var(--accent);
    display: grid; place-items: center; will-change: transform;
  }
  .ring i { width: 6px; height: 6px; border-radius: 2px; background: var(--accent); }
  .word { font-weight: 700; font-size: 21px; letter-spacing: -0.04em; }

  .transport { display: flex; gap: 8px; }
  .tbtn {
    width: 52px; height: 52px; border-radius: 15px;
    border: 1px solid var(--line); background: var(--raise);
    box-shadow: 0 4px 0 var(--edge), inset 0 1px 0 var(--hi);
    display: grid; place-items: center;
    transition: transform 60ms, box-shadow 60ms, background 120ms;
    touch-action: manipulation;
  }
  .tbtn:active { transform: translateY(4px); box-shadow: 0 0 0 var(--edge), inset 0 1px 0 var(--hi); }
  .tbtn.play { width: 64px; background: var(--ink); color: var(--panel); border-color: transparent; }
  .tbtn.play.on { background: var(--accent); color: var(--accent-ink); }
  .tbtn.rec i { width: 16px; height: 16px; border-radius: 50%; background: var(--rec); opacity: 0.55; transition: opacity 120ms, box-shadow 120ms; }
  .tbtn.rec.on i { opacity: 1; box-shadow: 0 0 0 4px color-mix(in srgb, var(--rec) 28%, transparent), 0 0 14px var(--rec); animation: blink 1s steps(2, jump-none) infinite; }
  @keyframes blink { 50% { opacity: 0.45; } }

  .lcdwrap { flex: 1 1 260px; min-width: 200px; }
  .knobs { display: flex; gap: 2px; }
  .group { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .pats { display: flex; gap: 3px; }
  .pat { font-size: 12px; width: 27px !important; height: 30px; }
  .pat.queued { animation: queued 0.4s steps(2, jump-none) infinite; }
  @keyframes queued { 50% { background: var(--accent); color: var(--accent-ink); } }

  .tools { display: flex; align-items: center; gap: 2px; }
  .tools .btn { padding: 0 9px; }
  .tools .btn.sq { padding: 0; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 6px; }
  .share { margin-left: 8px; padding: 0 14px !important; }
  .midi { position: relative; }
  .midi i { position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: 0; }
  .midi.live { color: var(--ink); }
  .midi.live::after { content: ''; position: absolute; bottom: 4px; left: 11px; right: 11px; height: 2px; border-radius: 1px; background: var(--accent); }

  @media (max-width: 900px) { .tools .btn.ghost span { display: none; } .tools .btn.ghost { width: 32px; padding: 0; } }
  @media (max-width: 720px) {
    .strip { padding: 10px 12px 0; }
    .deck { gap: 12px; padding: 10px 12px 12px; }
    .lcdwrap { order: 5; flex-basis: 100%; }
    .sep { display: none; }
  }
  @media (max-width: 520px) {
    .word { display: none; }
    .tools .share span { display: none; }
    .share { margin-left: 2px; padding: 0 10px !important; }
    .tools .btn.ghost { width: 30px; }
  }
</style>
