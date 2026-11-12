<script lang="ts">
  import { LATENCY_MODES, audio, latencySetting, setLatencySetting } from '../audio/host';
  import { connectMidi } from '../audio/midi-in';
  import { app } from '../state.svelte';
  import Modal from './Modal.svelte';

  const KEYS: [string, string][] = [
    ['Space', 'Play / stop'],
    ['1 – 8', 'Hit pads'],
    ['A S D F G H J K L ; \'', 'Play the selected synth up its scale (pads 1–8 on a drum track)'],
    ['Z / X', 'Keyboard octave down / up'],
    ['R', 'Record what you play into the pattern'],
    ['T', 'Tap tempo'],
    ['− / =', 'Tempo down / up (Shift: by 10)'],
    ['↑ / ↓', 'Select track'],
    ['← / →', 'Previous / next pattern'],
    ['V', 'Switch between pattern view and song view'],
    ['P', 'Pads: a full-screen view for playing live'],
    ['Del / Ctrl+D', 'Delete / duplicate the selected clip (song view)'],
    ['M / Shift+M', 'Mute / solo the selected track'],
    ['[ / ]', 'Previous / next panel'],
    ['Shift+Backspace', 'Clear the selected track'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Shift+C', 'Change colour theme'],
    ['?', 'This help'],
  ];
  const startedWith = latencySetting();
  let latency = $state(startedWith);
  const changed = $derived(latency !== startedWith);
  const MOUSE: [string, string][] = [
    ['Click a step', 'Turn it on or off'],
    ['Drag a step up / down', 'Set its velocity'],
    ['Drag along a row', 'Paint steps'],
    ['Drag a knob', 'Turn it (Shift for fine, double-click to reset)'],
    ['Drop an audio file on a track', 'Use it as that track\'s sound'],
    ['Piano roll', 'Click to add, drag to move or stretch, click a note to remove'],
  ];
</script>

<Modal title="Shortcuts and help" wide>
  <div class="cols">
    <section>
      <h3>Keyboard</h3>
      <dl>{#each KEYS as [k, d]}<dt><kbd>{k}</kbd></dt><dd>{d}</dd>{/each}</dl>
    </section>
    <section>
      <h3>Mouse and touch</h3>
      <dl class="stack">{#each MOUSE as [k, d]}<dt>{k}</dt><dd>{d}</dd>{/each}</dl>
      <h3>MIDI</h3>
      {#if app.midi.state === 'unsupported'}
        <p>This browser doesn't support Web MIDI. Chrome, Edge, Opera and Firefox do.</p>
      {:else if app.midi.state === 'on'}
        <p>
          {#if app.midi.inputs.length}Connected: <b>{app.midi.inputs.join(', ')}</b>{:else}MIDI is on. Plug in a controller and it will show up here.{/if}
        </p>
      {:else}
        <p>{app.midi.state === 'denied' ? 'MIDI access was blocked. Allow it in the site settings, then try again.' : 'Plug in a controller, then allow access.'}</p>
        <button class="btn" onclick={connectMidi}>Connect MIDI</button>
      {/if}
      <p class="small">Pad controllers (notes from C1, or anything on channel 10) hit the pads. Keyboards play the selected synth track, snapped to the scale when scale lock is on. CC7 is volume, CC1 the master filter, CC74 synth cutoff. MIDI start and stop work too.</p>
      <h3>Audio</h3>
      <div class="seg" role="radiogroup" aria-label="Audio latency">
        {#each LATENCY_MODES as m}
          <button class:on={latency === m} onclick={() => { latency = m; setLatencySetting(m); }} role="radio" aria-checked={latency === m}>{m}</button>
        {/each}
      </div>
      <p class="small">Output latency right now: <b>{Math.round(audio.latency * 1000)} ms</b> at {audio.sampleRate} Hz. “Lowest” asks for the smallest buffer the device allows, which makes pads feel tighter; “safe” trades that for fewer dropouts on a slow machine.
        {#if changed}A change takes effect when Loopwell is next opened.{/if}</p>
      <h3>About</h3>
      <p class="small">Loopwell is free and open source under the MIT licence. Everything runs in your browser, and it keeps working offline once loaded.
        <a href="https://github.com/aubergine-ux/loopwell" target="_blank" rel="noreferrer">Source on GitHub</a></p>
    </section>
  </div>
</Modal>

<style>
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
  h3 { margin: 14px 0 8px; font: 700 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  section > h3:first-child { margin-top: 4px; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 13px; align-items: baseline; }
  dl.stack { grid-template-columns: 1fr; gap: 0; }
  dl.stack dt { font-weight: 600; margin-top: 6px; }
  dl.stack dd { color: var(--dim); }
  dd { margin: 0; line-height: 1.35; }
  kbd {
    font: 600 11px var(--mono); padding: 2px 6px; border-radius: 6px; white-space: nowrap;
    background: var(--raise); border: 1px solid var(--line); box-shadow: 0 1px 0 var(--edge);
  }
  p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; }
  .small { color: var(--dim); font-size: 12px; margin-top: 8px; }
  a { color: var(--accent); font-weight: 600; }
  @media (max-width: 640px) { .cols { grid-template-columns: 1fr; gap: 0; } }
</style>
