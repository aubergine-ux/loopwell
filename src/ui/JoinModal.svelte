<script lang="ts">
  import { joinSession, live, savedName } from '../live/session.svelte';
  import { app } from '../state.svelte';
  import Modal from './Modal.svelte';

  let name = $state(savedName());
  function join(): void {
    joinSession(live.invite, name);
    app.modal = null;
    app.tab = 'live';
  }
</script>

<Modal title="Join the session">
  <p>You have been invited to make a beat together. Everyone in the session sees and hears the same beat, and edits show up as they happen.</p>
  <p>The session's beat will replace the one on your screen. Yours is not lost: undo brings it back after you leave.</p>
  <form onsubmit={(e) => { e.preventDefault(); join(); }}>
    <input bind:value={name} maxlength="24" placeholder="Your name" aria-label="Your name" />
    <button class="btn on" disabled={!name.trim()}>Join</button>
  </form>
</Modal>

<style>
  p { margin: 6px 0 12px; font-size: 14px; line-height: 1.45; }
  form { display: flex; gap: 8px; }
  input {
    flex: 1; height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 13px var(--mono); user-select: text; -webkit-user-select: text;
  }
</style>
