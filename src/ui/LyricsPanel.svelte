<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { checkpoint } from '../actions.svelte';
  import { posLabel } from '../core/arrange';
  import { MAX_LYRICS, MAX_SONG_STEPS, type LyricLine } from '../core/types';
  import { seek } from '../song.svelte';
  import { app } from '../state.svelte';
  import { onFrame } from '../visual';
  import Icon from './Icon.svelte';

  // Words for the song, each line pinned to the step it is sung on. While the song plays, the line being
  // sung is shown large with the next ones under it, like a prompter.
  const p = $derived(app.project);
  const lines = $derived(p.lyrics);
  let now = $state(-1); // index of the line being sung
  let here = $state(0); // where the song is, in steps
  let pasting = $state(false);
  let pasted = $state('');
  let list = $state<HTMLElement>();
  const full = $derived(lines.length >= MAX_LYRICS);

  /** Where a new line goes: the playhead while playing, otherwise a bar after the last line (or the cursor). */
  const spot = () => (app.playing ? here : lines.length ? Math.min(MAX_SONG_STEPS - 1, lines[lines.length - 1].at + 16) : app.cursor);
  const sort = () => { p.lyrics = [...p.lyrics].sort((a, b) => a.at - b.at); };

  async function add(text = '', at = spot()): Promise<void> {
    if (full) return;
    checkpoint();
    const line: LyricLine = { at, text };
    p.lyrics.push(line);
    sort();
    await tick();
    list?.querySelectorAll<HTMLInputElement>('input.text')[p.lyrics.findIndex((l) => l.at === at && l.text === text)]?.focus();
  }
  function stamp(i: number): void {
    // pin the line to where the song is now: press it as the line is sung
    p.lyrics[i].at = app.playing ? here : app.cursor;
    sort();
  }
  function remove(i: number): void {
    p.lyrics.splice(i, 1);
  }
  function key(e: KeyboardEvent, i: number): void {
    if (e.key === 'Enter') { e.preventDefault(); void add('', Math.min(MAX_SONG_STEPS - 1, lines[i].at + 16)); }
    else if (e.key === 'Backspace' && !lines[i].text && lines.length > 1) { e.preventDefault(); remove(i); }
  }
  function paste(): void {
    const rows = pasted.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, MAX_LYRICS - lines.length);
    if (!rows.length) { pasting = false; return; }
    checkpoint();
    let at = spot();
    for (const text of rows) { p.lyrics.push({ at, text: text.slice(0, 120) }); at = Math.min(MAX_SONG_STEPS - 1, at + 16); }
    sort();
    pasted = '';
    pasting = false;
  }

  onMount(() => onFrame((head) => {
    const at = head ? (head.song >= 0 ? head.song : head.step) : app.cursor;
    if (at !== here) here = at;
    let i = -1;
    for (let k = 0; k < lines.length; k++) if (lines[k].at <= at) i = k; else break;
    if (i !== now) {
      now = i;
      list?.querySelectorAll('li')[i]?.scrollIntoView({ block: 'nearest' });
    }
  }));
</script>

<div class="lyrics">
  <div class="edit">
    <div class="bar">
      <span class="label">Lyrics</span>
      <button class="btn" onclick={() => add()} disabled={full} title="Add a line {app.playing ? 'where the song is now' : 'a bar after the last one'}"><Icon name="plus" size={12} />Line</button>
      <button class="btn ghost" onclick={() => (pasting = !pasting)} disabled={full}>{pasting ? 'Cancel' : 'Paste lines…'}</button>
      <span class="count">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
    </div>
    {#if pasting}
      <textarea bind:value={pasted} rows="5" placeholder="Paste or type your words, one line of the song per line. Each goes a bar after the one before." aria-label="Lines to add" spellcheck="true"></textarea>
      <button class="btn on" onclick={paste} disabled={!pasted.trim()}>Add these lines</button>
    {:else if !lines.length}
      <p>Write the words here, one line at a time. Each line is pinned to a place in the song, and scrolls past as it plays.
        Press the position on a line while the song plays to pin it to that moment.</p>
    {:else}
      <ol bind:this={list}>
        {#each lines as l, i (i)}
          <li class:now={i === now}>
            <button class="at" onclick={() => stamp(i)} ondblclick={() => seek(l.at)}
              aria-label="Line {i + 1} is at {posLabel(p, l.at)}. Press to move it to where the song is now."
              title="Press to pin this line to where the song is now. Double-click to go there.">{posLabel(p, l.at)}</button>
            <input class="text" bind:value={l.text} maxlength="120" aria-label="Line {i + 1}" placeholder="…" onkeydown={(e) => key(e, i)} spellcheck="true" />
            <button class="btn ghost sq" onclick={() => remove(i)} aria-label="Delete line {i + 1}"><Icon name="x" size={12} /></button>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
  <div class="prompter" aria-live="off">
    {#if lines.length}
      <span class="prev">{lines[now - 1]?.text ?? ''}</span>
      <b>{now >= 0 ? lines[now].text || '…' : ''}</b>
      <span>{lines[now + 1]?.text ?? ''}</span>
      <span class="far">{lines[now + 2]?.text ?? ''}</span>
    {:else}
      <span class="far">The line being sung shows here while the song plays.</span>
    {/if}
  </div>
</div>

<style>
  .lyrics { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  .edit { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 6px; }
  .bar .btn { height: 28px; font-size: 10px; padding: 0 9px; gap: 4px; }
  .count { margin-left: auto; font: 600 10px var(--mono); color: var(--dim); }
  p { margin: 0; font-size: 13px; line-height: 1.45; color: var(--dim); max-width: 440px; }
  ol { list-style: none; margin: 0; padding: 4px; max-height: 208px; overflow-y: auto; border-radius: 10px; background: var(--inset); scrollbar-width: thin; }
  li { display: flex; align-items: center; gap: 4px; border-radius: 7px; padding: 1px 2px; }
  li.now { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .at { flex: 0 0 58px; height: 26px; border: 0; border-radius: 6px; background: var(--well); font: 700 10px var(--mono); color: var(--dim); }
  li.now .at { background: var(--accent); color: var(--accent-ink); }
  .text, textarea {
    flex: 1; min-width: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; padding: 0 8px; height: 26px;
    font-size: 14px; user-select: text; -webkit-user-select: text;
  }
  .text:focus, textarea:focus { border-color: var(--line); background: var(--panel); outline: none; }
  textarea { height: auto; padding: 8px; background: var(--inset); resize: vertical; font-family: inherit; line-height: 1.4; }
  li .btn.sq { width: 24px; height: 24px; }
  .prompter {
    display: flex; flex-direction: column; justify-content: center; gap: 6px; min-height: 200px; padding: 16px 20px; border-radius: 14px;
    background: var(--lcd-bg); color: var(--lcd-dim); font-size: 15px; overflow: hidden;
  }
  .prompter b { font-size: 26px; line-height: 1.15; letter-spacing: -0.02em; color: var(--lcd-fg); min-height: 30px; }
  .prompter .prev { opacity: 0.6; font-size: 13px; min-height: 16px; }
  .prompter .far { opacity: 0.6; font-size: 13px; }
  @media (max-width: 720px) { .lyrics { grid-template-columns: minmax(0, 1fr); } .prompter { min-height: 120px; order: -1; } .prompter b { font-size: 20px; } }
</style>
