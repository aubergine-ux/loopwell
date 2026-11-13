<script lang="ts">
  import { LATENCY_MODES, audio, latencySetting, setLatencySetting } from '../audio/host';
  import { connectMidi } from '../audio/midi-in';
  import { COMMANDS, combo, keyLabel, keymap, keysFor, rebind, resetKeys, type Command } from '../commands.svelte';
  import { prefs, setPref } from '../prefs.svelte';
  import { startTour } from '../tour.svelte';
  import { app } from '../state.svelte';
  import Modal from './Modal.svelte';

  // keys that play: these are fixed, everything else in the list can be changed
  const PLAYING: [string, string][] = [
    ['1 – 8', 'Hit pads'],
    ['A S D F G H J K L ; \'', 'Play the selected track up its scale, or its slices (pads 1–8 on a drum track)'],
    ['\\', 'Hold for a fill'],
    ['Esc', 'Close whatever is open'],
  ];
  const groups = $derived.by(() => {
    const out: { name: string; items: Command[] }[] = [];
    for (const c of COMMANDS) {
      // a command with no shortcut is listed only once it has been given one; the palette has them all
      if (!c.keys && !keysFor(c)) continue;
      const g = out.find((x) => x.name === c.group);
      if (g) g.items.push(c); else out.push({ name: c.group, items: [c] });
    }
    return out;
  });
  const changed2 = $derived(Object.keys(keymap.custom).length > 0);

  /** The command waiting for a new key, if one is. */
  let binding = $state<string | null>(null);
  let note = $state('');
  function capture(e: KeyboardEvent): void {
    if (!binding) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // wait for the key itself
    if (e.key === 'Escape') { binding = null; return; }
    const res = rebind(binding, e.key === 'Backspace' || e.key === 'Delete' ? '' : combo(e));
    note = res.ok ? (res.took ? `That key was “${res.took}”, which now has none.` : '') : res.why ?? '';
    if (res.ok) binding = null;
  }
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

<svelte:window onkeydowncapture={capture} />

<Modal title="Shortcuts and help" wide>
  <div class="cols">
    <section>
      <h3>Keyboard</h3>
      <p class="small">Press <kbd>{keyLabel(keysFor(COMMANDS.find((c) => c.id === 'palette')!))}</kbd> to find any action, sound or setting by name.
        Click a shortcut below to change it.</p>
      <dl>{#each PLAYING as [k, d]}<dt><kbd>{k}</kbd></dt><dd>{d}</dd>{/each}</dl>
      {#each groups as g}
        <h4>{g.name}</h4>
        <dl>
          {#each g.items as c (c.id)}
            <dt>
              <button class="key" class:wait={binding === c.id} class:custom={c.id in keymap.custom} onclick={() => { binding = binding === c.id ? null : c.id; note = ''; }}
                aria-label="Shortcut for {c.title}: {keyLabel(keysFor(c)) || 'none'}. Press to change."
                title="Click, then press the new key. Backspace for none, Esc to cancel.">{binding === c.id ? 'Press a key…' : keyLabel(keysFor(c)) || '—'}</button>
            </dt>
            <dd>{c.title}</dd>
          {/each}
        </dl>
      {/each}
      {#if note}<p class="small" role="status">{note}</p>{/if}
      <button class="btn" onclick={() => { resetKeys(); note = ''; }} disabled={!changed2}>Reset shortcuts</button>
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
      <h3>Settings</h3>
      <label class="check"><input type="checkbox" checked={prefs.tips} onchange={(e) => setPref('tips', e.currentTarget.checked)} /> Tooltips that explain each control</label>
      <label class="check"><input type="checkbox" checked={prefs.calm} onchange={(e) => setPref('calm', e.currentTarget.checked)} /> Reduce motion</label>
      <button class="btn" onclick={() => void startTour()}>Show the walkthrough</button>
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
  h4 { margin: 12px 0 6px; font: 700 9.5px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); opacity: 0.8; }
  .key {
    font: 600 11px var(--mono); padding: 2px 6px; border-radius: 6px; white-space: nowrap; min-width: 28px;
    background: var(--raise); border: 1px solid var(--line); box-shadow: 0 1px 0 var(--edge);
  }
  .key.custom { border-color: var(--accent); }
  .key.wait { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 6px 0; }
  section > .btn { margin-top: 10px; height: 30px; font-size: 11px; }
  a { color: var(--accent); font-weight: 600; }
  @media (max-width: 640px) { .cols { grid-template-columns: 1fr; gap: 0; } }
</style>
