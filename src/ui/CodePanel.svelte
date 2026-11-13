<script lang="ts">
  import { onMount } from 'svelte';
  import { checkpoint } from '../actions.svelte';
  import { CODE_EXAMPLE, codeFromGrid, codeToGrid } from '../code.svelte';
  import { MAX_CODE, codeInfo, compileCode, type CodeLine } from '../core/mini';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';

  // Patterns typed as text, in the mini-notation TidalCycles and Strudel use. Every keystroke is compiled and, if it
  // makes sense, heard from the next step on; a line with a mistake in it keeps playing what it played before.
  const p = $derived(app.project);
  let last: CodeLine[] = [];
  const lines = $derived.by(() => (last = compileCode(p.code, codeInfo(p), last)));
  const errors = $derived(lines.filter((l) => l.error));
  const rows = $derived(p.code.split('\n').length);
  let head = $state(-1); // how far through the bar playback is, 0..1
  let bar = $state(0);
  let area = $state<HTMLTextAreaElement>();
  let help = $state(false);

  onMount(() => {
    let count = 0, lastStep = -1;
    return onFrame((h) => {
      if (!h) { if (head >= 0) { head = -1; bar = 0; } count = 0; lastStep = -1; return; }
      const step = h.song >= 0 ? h.song % p.steps : h.step;
      // the bar count is what < > and ? go by: it starts again whenever playback does
      if (h.song >= 0) count = Math.floor(h.song / p.steps);
      else if (step < lastStep) count++;
      lastStep = step;
      const at = step / p.steps;
      if (at !== head) head = at;
      if (count !== bar) bar = count;
    });
  });

  let typed = 0;
  function input(e: Event): void {
    // one undo step for a burst of typing, not one for every letter
    const now = performance.now();
    if (now - typed > 1500) checkpoint();
    typed = now;
    p.code = (e.currentTarget as HTMLTextAreaElement).value.slice(0, MAX_CODE);
    if (p.code.trim() && !p.codeOn && !wasOff) p.codeOn = true;
  }
  // switched off by hand stays off while typing
  let wasOff = $state(!app.project.codeOn);
  function toggle(): void {
    checkpoint();
    p.codeOn = !p.codeOn;
    wasOff = !p.codeOn;
  }
  function example(): void {
    checkpoint();
    p.code = p.code.trim() ? `${p.code.replace(/\s+$/, '')}\n${CODE_EXAMPLE}` : CODE_EXAMPLE;
    p.codeOn = true;
    wasOff = false;
    area?.focus();
  }
  function clear(): void {
    checkpoint();
    p.code = '';
  }
  function keys(e: KeyboardEvent): void {
    // Tab moves on, as everywhere else; the app's own single-letter shortcuts stay out of the way of typing
    e.stopPropagation();
    if (e.key === 'Escape') (e.currentTarget as HTMLElement).blur();
  }
  /** Put the cursor where a mistake is. */
  function goTo(l: CodeLine): void {
    if (!area || !l.error) return;
    const before = p.code.split('\n').slice(0, l.line).join('\n').length + (l.line ? 1 : 0);
    area.focus();
    area.setSelectionRange(before + l.error.col, before + l.error.col + 1);
  }
  const lane = (l: CodeLine) => l.cycles[bar % Math.max(1, l.cycles.length)];

  const SYNTAX: [string, string][] = [
    ['x ~ x ~', 'Things in a row share the bar. ~ is a rest.'],
    ['x x x', 'Three things: a triplet. However many there are, they fit.'],
    ['[x x] x', 'Brackets group: two hits in the first half.'],
    ['x*4   x/2', 'Faster and slower: four times in its slot; once every two bars.'],
    ['x _ _ x   x@3 x', 'Hold: the first lasts three shares of the time.'],
    ['x!3 ~', 'Repeat: the same as x x x ~.'],
    ['<a b c>', 'Take turns: one each bar.'],
    ['x(3,8)', 'Spread 3 hits evenly over 8 steps. A third number turns the pattern.'],
    ['[c4,eb4,g4]', 'Together: a chord, or two rhythms at once.'],
    ['x?   x?0.2', 'Maybe: leave it out half the time, or 20% of it.'],
    ['a | b', 'Pick one at random each bar.'],
    ['c4 eb3 f#2', 'Notes by name on synth, 808 and plugin tracks.'],
    ['0 2 4 7', 'Or by number: steps of the song\'s scale, from the track\'s own note.'],
    ['x X', 'On drums any word is a hit; a capital is an accent. On a sliced track, numbers are slices.'],
    ['// words', 'A comment.'],
  ];
</script>

<div class="code">
  <div class="edit">
    <div class="bar">
      <button class="btn" class:on={p.codeOn} onclick={toggle} aria-pressed={p.codeOn} title="Play the code along with the grid">{p.codeOn ? 'On' : 'Off'}</button>
      <button class="btn ghost" onclick={example} title="Add a few lines to start from">Example</button>
      <button class="btn ghost" onclick={codeFromGrid} title="Write the pattern on screen out as code">From grid</button>
      <button class="btn ghost" onclick={codeToGrid} disabled={!lines.some((l) => !l.error)} title="Write what the code plays onto the grid, on the nearest steps">To grid</button>
      <button class="btn ghost" onclick={clear} disabled={!p.code}>Clear</button>
      <button class="btn ghost" class:on={help} onclick={() => (help = !help)} aria-expanded={help}>How to write it</button>
      <span class="count" class:near={p.code.length > MAX_CODE - 200}>{p.code.length} / {MAX_CODE}</span>
    </div>
    <textarea bind:this={area} value={p.code} oninput={input} onkeydown={keys} onkeyup={(e) => e.stopPropagation()} rows={Math.max(5, Math.min(14, rows + 1))}
      spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Live code" aria-describedby="code-status"
      placeholder={'kick:  x ~ ~ x  ~ ~ x ~\nhat:   [x x x]*4\nlead:  <c4 eb4 g4> ~ [c5 g4]/2'}></textarea>
    <div id="code-status" class="status" role="status" aria-live="polite">
      {#if !p.code.trim()}
        Type a line like <code>kick: x ~ x ~</code>. It plays from the next step, in time with everything else. Track names: {p.tracks.map((t) => t.name.toLowerCase()).join(', ')}.
      {:else if errors.length}
        {#each errors as l (l.line)}
          <button class="err" onclick={() => goTo(l)}>Line {l.line + 1}: {l.error!.message}{l.cycles.length ? '. Still playing what it had before.' : ''}</button>
        {/each}
      {:else if !p.codeOn}
        Switched off: the code is not playing.
      {:else}
        {lines.length} line{lines.length === 1 ? '' : 's'} playing{app.playing ? '' : ' when you press play'}.
      {/if}
    </div>
  </div>

  <div class="side">
    {#if help}
      <dl class="help">
        {#each SYNTAX as [a, b]}<dt><code>{a}</code></dt><dd>{b}</dd>{/each}
      </dl>
    {:else}
      <div class="lanes" class:off={!p.codeOn} aria-hidden="true">
        {#each lines.filter((l) => l.cycles.length) as l (l.line)}
          {@const c = lane(l)}
          <div class="lane" class:bad={l.error} style:--c="var(--t{p.tracks[l.track]?.color ?? 0})">
            <span class="who">{p.tracks[l.track]?.name}</span>
            <div class="strip">
              {#each c.t as t, i}<i style:left="{t * 100}%" style:width="max(3px, calc({c.d[i] * 100}% - 2px))" style:opacity={c.v[i] > 110 ? 1 : 0.7}></i>{/each}
              {#if head >= 0}<b style:left="{head * 100}%"></b>{/if}
            </div>
            {#if l.cycles.length > 1}<span class="turn" title="This line changes from bar to bar">{(bar % l.cycles.length) + 1}/{l.cycles.length}</span>{/if}
          </div>
        {:else}
          <p class="hint">Each line shows here as a bar, with a hit for everything it plays.</p>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .code { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; min-width: 0; }
  .edit { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .bar .btn { height: 28px; font-size: 10px; padding: 0 10px; }
  .count { margin-left: auto; font: 600 10px var(--mono); color: var(--dim); }
  .count.near { color: var(--rec); }
  textarea {
    width: 100%; resize: vertical; min-height: 110px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
    background: var(--lcd-bg); color: var(--lcd-fg); font: 500 13px/1.6 var(--mono); tab-size: 2; white-space: pre; overflow-x: auto;
    user-select: text; -webkit-user-select: text; caret-color: var(--accent);
  }
  textarea::placeholder { color: var(--lcd-dim); }
  .status { font-size: 12px; line-height: 1.45; color: var(--dim); display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  code { font: 600 11px var(--mono); padding: 1px 5px; border-radius: 5px; background: var(--inset); color: var(--ink); white-space: pre; }
  .err { text-align: left; border: 0; padding: 6px 10px; border-radius: 8px; background: var(--rec); color: var(--on-c); font-size: 12px; line-height: 1.35; }
  .side { min-width: 0; }
  .lanes { display: flex; flex-direction: column; gap: 6px; }
  .lanes.off { opacity: 0.45; }
  .lane { display: grid; grid-template-columns: 64px minmax(0, 1fr) 34px; align-items: center; gap: 8px; }
  .who { font: 600 10px var(--mono); letter-spacing: 0.06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip {
    position: relative; height: 20px; border-radius: 6px; background: var(--inset); overflow: hidden;
    background-image: linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 25% 100%;
  }
  .strip i { position: absolute; top: 4px; bottom: 4px; border-radius: 3px; background: var(--c); }
  .strip b { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink); }
  .lane.bad .strip { outline: 1px dashed var(--rec); }
  .turn { font: 600 10px var(--mono); color: var(--dim); }
  .hint { margin: 0; font-size: 12px; color: var(--dim); }
  .help { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 12px; line-height: 1.4; align-items: baseline; }
  .help dt, .help dd { margin: 0; }
  .help dd { color: var(--dim); }
  @media (max-width: 820px) { .code { grid-template-columns: minmax(0, 1fr); } }
</style>
