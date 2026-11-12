<script lang="ts">
  import { toast } from '../actions.svelte';
  import { endSession, inviteLink, isLocked, kick, leave, live, lockTrack, sendChat, setReadOnly } from '../live/session.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  let show = $state<'chat' | 'log'>('chat');
  let text = $state('');
  let feed = $state<HTMLElement>();
  const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  $effect(() => { live.unread = 0; void live.chat.length; });
  // keep the newest line in view
  $effect(() => {
    void live.chat.length; void live.log.length; void show;
    queueMicrotask(() => feed?.scrollTo({ top: feed.scrollHeight }));
  });

  function send(): void {
    sendChat(text);
    text = '';
  }
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied'); } catch { toast('Copy the link from the box instead.', 'error'); }
  }
</script>

<div class="live">
  <div class="left">
    <div class="row">
      <span class="label">{live.online ? 'In this session' : 'Reconnecting…'}</span>
      {#if live.readOnly}<span class="badge">view-only</span>{/if}
    </div>
    <div class="peers">
      {#each live.peers as p (p.id)}
        <div class="peer" style:--c="var(--t{p.color})">
          <i></i><b>{p.name}</b>
          {#if p.host}<small>host</small>{/if}
          {#if p.id === live.me}<small>you</small>{/if}
          {#if live.host && p.id !== live.me}
            <button class="x" onclick={() => kick(p.id)} aria-label="Remove {p.name} from the session" title="Remove from the session">×</button>
          {/if}
        </div>
      {/each}
    </div>
    <div class="row">
      <input class="link" readonly value={inviteLink()} aria-label="Invite link" onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
      <button class="btn" onclick={copy}><Icon name="copy" size={13} />Copy invite</button>
    </div>
    {#if live.host}
      <div class="row">
        <span class="label">Host</span>
        <button class="btn" class:on={live.readOnly} onclick={() => setReadOnly(!live.readOnly)} aria-pressed={live.readOnly}
          title="Only you can edit; everyone else watches and listens">View-only for guests</button>
      </div>
      <div class="row">
        <span class="label">Lock</span>
        {#each app.project.tracks as t, i}
          <button class="lock" class:on={isLocked(i)} style:--c="var(--t{t.color})" onclick={() => lockTrack(i, !isLocked(i))} aria-pressed={isLocked(i)}
            aria-label="Lock {t.name}" title="Only you can change {t.name} while it is locked">{t.name}</button>
        {/each}
      </div>
    {/if}
    <div class="row">
      <button class="btn ghost" onclick={() => leave()}>Leave</button>
      {#if live.host}<button class="btn ghost" onclick={endSession}>End the session for everyone</button>{/if}
    </div>
  </div>
  <div class="right">
    <div class="seg">
      <button class:on={show === 'chat'} onclick={() => (show = 'chat')}>Chat</button>
      <button class:on={show === 'log'} onclick={() => (show = 'log')}>Activity</button>
    </div>
    <div class="feed" bind:this={feed} role="log" aria-label={show === 'chat' ? 'Chat' : 'Activity'}>
      {#if show === 'chat'}
        {#each live.chat as m}
          <p style:--c="var(--t{m.color})"><b>{m.name}</b> {m.text} <time>{time(m.at)}</time></p>
        {:else}
          <p class="none">Say hello. Messages stay for as long as the session does.</p>
        {/each}
      {:else}
        {#each live.log as e}
          <p style:--c="var(--t{e.color})"><b>{e.name}</b> <span>{e.what}</span> <time>{time(e.at)}</time></p>
        {:else}
          <p class="none">Who changed what shows up here.</p>
        {/each}
      {/if}
    </div>
    {#if show === 'chat'}
      <form class="row" onsubmit={(e) => { e.preventDefault(); send(); }}>
        <input bind:value={text} maxlength="500" placeholder="Message" aria-label="Message" />
        <button class="btn on" disabled={!text.trim()}>Send</button>
      </form>
    {/if}
  </div>
</div>

<style>
  .live { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; }
  .left, .right { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .right { padding-left: 22px; border-left: 1px solid var(--line); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .btn { height: 30px; font-size: 10px; padding: 0 10px; }
  .badge { padding: 1px 7px; border-radius: 6px; background: var(--rec); color: #fff; font: 700 9.5px var(--mono); text-transform: uppercase; letter-spacing: 0.08em; }
  .peers { display: flex; flex-wrap: wrap; gap: 6px; }
  .peer { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border-radius: 14px; background: var(--inset); font-size: 13px; }
  .peer i { width: 10px; height: 10px; border-radius: 50%; background: var(--c); }
  .peer small { font: 700 9px var(--mono); text-transform: uppercase; color: var(--dim); }
  .x { border: 0; background: none; padding: 0 2px; font: 700 15px var(--mono); color: var(--dim); }
  .x:hover { color: var(--rec); }
  input {
    flex: 1; min-width: 0; height: 30px; padding: 0 9px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 11px var(--mono); user-select: text; -webkit-user-select: text;
  }
  .lock {
    height: 24px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--raise); color: var(--dim);
    font: 700 9.5px var(--mono); letter-spacing: 0.06em;
  }
  .lock.on { background: var(--c); color: #fff; border-color: transparent; }
  .feed { height: 150px; overflow-y: auto; padding: 8px 10px; border-radius: 12px; background: var(--inset); box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.14); user-select: text; -webkit-user-select: text; }
  .feed p { margin: 0 0 4px; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
  .feed b { color: var(--c); }
  .feed span { color: var(--dim); }
  .feed time { font: 600 9.5px var(--mono); color: var(--dim); opacity: 0.7; }
  .feed .none { color: var(--dim); }
  @media (max-width: 900px) { .live { grid-template-columns: 1fr; } .right { padding-left: 0; border-left: 0; } }
</style>
