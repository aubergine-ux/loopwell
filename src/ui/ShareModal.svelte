<script lang="ts">
  import { customSampleCount, saveProjectFile, shareUrl, toast } from '../actions.svelte';
  import { community } from '../community/store.svelte';
  import { live, savedName, startSession } from '../live/session.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  const url = $derived(shareUrl());
  const custom = $derived(customSampleCount());
  let copied = $state(false);
  const canShare = typeof navigator.share === 'function';

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API needs a secure context; fall back to selecting the text
      const el = document.querySelector<HTMLTextAreaElement>('#share-url');
      el?.select();
      if (!document.execCommand('copy')) { toast('Select the link and copy it manually.', 'error'); return; }
    }
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
  let jamName = $state(savedName());
  function jam(): void {
    startSession(jamName);
    app.modal = null;
    app.tab = 'live';
  }
  function native(): void {
    navigator.share({ title: `${app.project.name} · Loopwell`, url }).catch(() => {});
  }
</script>

<Modal title="Share this beat">
  <label class="field">
    <span class="label">Name</span>
    <input bind:value={app.project.name} maxlength="40" spellcheck="false" placeholder="untitled" />
  </label>
  <p>The whole beat lives inside this link. Anyone who opens it hears it straight away, with no account and nothing uploaded.</p>
  <textarea id="share-url" readonly rows="4" value={url} onfocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()}></textarea>
  <div class="row">
    <button class="btn on big" onclick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy link'}</button>
    {#if canShare}<button class="btn big" onclick={native}><Icon name="share" />Share…</button>{/if}
    <span class="count">{url.length} characters</span>
  </div>
  {#if custom}
    <div class="note">
      <b>{custom} track{custom === 1 ? ' uses' : 's use'} your own samples.</b>
      Audio files are too big for a link, so those tracks will be silent for other people. Send a project file instead; it bundles the samples.
      <button class="btn" onclick={saveProjectFile}><Icon name="file" />Save project file</button>
    </div>
  {/if}
  <div class="jam">
    <b>Make it together, live</b>
    {#if live.on}
      <span>You are in a live session. The invite link is in the Live tab.</span>
    {:else if community.server}
      <span>Start a session and send the invite: everyone edits the same beat at once and hears it in time.</span>
      <form onsubmit={(e) => { e.preventDefault(); jam(); }}>
        <input bind:value={jamName} maxlength="24" placeholder="Your name" aria-label="Your name" />
        <button class="btn" disabled={!jamName.trim()}>Start a live session</button>
      </form>
    {:else}
      <span>Live sessions go through a Loopwell server. Connect to one under Community to start or join one.</span>
    {/if}
  </div>
</Modal>

<style>
  p { margin: 10px 0; font-size: 14px; line-height: 1.45; }
  .field { display: flex; align-items: center; gap: 10px; }
  .field input {
    flex: 1; height: 36px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font-weight: 600; user-select: text; -webkit-user-select: text;
  }
  textarea {
    width: 100%; resize: none; padding: 10px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--inset); font: 12px/1.4 var(--mono); word-break: break-all; user-select: text; -webkit-user-select: text;
  }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .big { height: 40px; padding: 0 16px; }
  .jam { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 1.45; }
  .jam form { display: flex; gap: 8px; margin-top: 2px; }
  .jam input {
    flex: 1; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  .count { margin-left: auto; font: 600 11px var(--mono); color: var(--dim); }
  .note {
    margin-top: 14px; padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--t1) 18%, var(--panel));
    font-size: 13px; line-height: 1.45; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  }
</style>
