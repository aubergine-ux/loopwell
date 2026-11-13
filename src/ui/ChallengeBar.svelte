<script lang="ts">
  import { play, stop } from '../actions.svelte';
  import { CHALLENGES, PASS, hint } from '../core/learn';
  import { endChallenge, judge, learn, listen, nextChallenge, record, startChallenge, stopListening } from '../learn.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  // Sits above the beat while one is being recreated: the beat to match on one side, how close the attempt is on the other.
  const c = $derived(learn.challenge!);
  const info = $derived(CHALLENGES.find((x) => x.id === c.id)!);
  const now = $derived(judge()!);
  const pct = $derived(Math.round(now.score * 100));
  const won = $derived(now.score >= PASS);
  const next = $derived(nextChallenge());
  let peek = $state(false);
  let timer = 0;

  $effect(() => { record(now.score); });

  function mine(): void {
    stopListening();
    if (app.playing) stop(); else void play();
  }
  function showIt(): void {
    c.peeked = true;
    peek = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => (peek = false), 4000);
  }
  // what the target plays on a track, for the peek: one mark per step that has something on it
  const marks = (t: number) => {
    const pat = c.target.patterns[0], out = new Array<boolean>(c.target.steps).fill(false);
    pat.steps[t]?.forEach((v, s) => { if (v > 0 && s < out.length) out[s] = true; });
    for (const n of pat.notes[t] ?? []) if (n.s < out.length) out[n.s] = true;
    return out;
  };
  const rows = $derived(c.target.tracks.map((t, i) => ({ name: t.name, color: t.color, on: marks(i) })).filter((r) => r.on.some(Boolean)));
</script>

<aside class="challenge" class:won aria-label="Recreate this beat: {info.name}">
  <div class="what">
    <span class="label">Recreate this beat</span>
    <b>{info.name}</b>
  </div>
  <div class="btns">
    <button class="btn" class:on={learn.listening} onclick={listen} aria-pressed={learn.listening} title="Play the beat you are trying to match"><Icon name={learn.listening ? 'stop' : 'play'} size={13} />{learn.listening ? 'Stop' : 'Hear it'}</button>
    <button class="btn" onclick={mine} title="Play what you have made so far (Space)"><Icon name={app.playing ? 'stop' : 'play'} size={13} />{app.playing ? 'Stop mine' : 'Hear mine'}</button>
    <button class="btn ghost" onclick={showIt} title="See where the hits are, for a few seconds">Peek</button>
  </div>
  <div class="score" role="status" aria-live="polite" aria-label="{pct}% the same{won ? ': matched' : ''}">
    <div class="meter" aria-hidden="true"><i style:width="{pct}%"></i><em style:left="{PASS * 100}%"></em></div>
    <b>{pct}%</b>
    <span class="say">{won && now.score < 1 ? `Close enough to pass. ${now.missing + now.extra} off for a perfect match` : won ? (c.peeked ? 'Matched, with a peek' : 'Matched!') : now.right === 0 && now.extra === 0 ? 'Listen, then build it in the grid' : `${now.missing} to find${now.extra ? `, ${now.extra} that shouldn't be there` : ''}`}</span>
  </div>
  <ul class="tracks">
    {#each now.tracks as t (t.track)}
      <li class:ok={!t.missing && !t.extra} style:--c="var(--t{c.target.tracks[t.track].color})" title="{t.name}: {hint(t)}">
        <i></i>{t.name}<small>{!t.missing && !t.extra ? '✓' : hint(t)}</small>
      </li>
    {/each}
  </ul>
  <div class="end">
    {#if won && next}<button class="btn on" onclick={() => void startChallenge(next)}>Next beat</button>{/if}
    <button class="btn ghost" onclick={() => { endChallenge(); app.modal = 'learn'; }}>{won ? 'Done' : 'Leave'}</button>
  </div>
  {#if peek}
    <div class="peek" role="img" aria-label="Where the hits are in the beat to match">
      {#each rows as r}
        <div class="prow" style:--c="var(--t{r.color})"><span>{r.name}</span><div class="dots" style:--n={r.on.length}>{#each r.on as on}<i class:on></i>{/each}</div></div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .challenge {
    position: relative; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; margin: 0 0 10px; border-radius: 14px;
    background: var(--inset); border: 1px solid var(--line);
  }
  .challenge.won { border-color: var(--t3); }
  .what { display: flex; flex-direction: column; gap: 1px; }
  .what b { font-size: 15px; }
  .btns, .end { display: flex; gap: 6px; align-items: center; }
  .btn { height: 30px; font-size: 10px; padding: 0 10px; gap: 5px; }
  .score { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .meter { position: relative; width: 120px; height: 10px; border-radius: 5px; background: var(--well); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
  .won .meter i { background: var(--t3); }
  .meter em { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink); opacity: 0.5; }
  .score b { font: 700 14px var(--mono); min-width: 42px; }
  .say { font-size: 12px; color: var(--dim); }
  /* the track list and the peek go underneath; the way out stays up on the first line */
  .tracks { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; flex-wrap: wrap; flex: 1 1 100%; order: 5; }
  .tracks li { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; border-radius: 9px; background: var(--panel); font: 600 10px var(--mono); letter-spacing: 0.04em; }
  .tracks li i { width: 8px; height: 8px; border-radius: 3px; background: var(--c); }
  .tracks small { font-size: 10px; font-weight: 500; color: var(--dim); letter-spacing: 0; }
  .tracks li.ok small { color: var(--t3); font-weight: 700; }
  .end { margin-left: auto; }
  .peek { order: 6; flex: 1 1 100%; display: flex; flex-direction: column; gap: 3px; padding-top: 4px; }
  .prow { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; align-items: center; font: 600 9px var(--mono); }
  .dots { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 2px; }
  .dots i { height: 8px; border-radius: 2px; background: var(--well); }
  .dots i:nth-child(4n + 1) { background: var(--well-alt); }
  .dots i.on { background: var(--c); }
  @media (prefers-reduced-motion: reduce) { .meter i { transition: none; } }
</style>
