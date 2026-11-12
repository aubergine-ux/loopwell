<script lang="ts">
  import type { Snippet } from 'svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { title, children, wide = false }: { title: string; children: Snippet; wide?: boolean } = $props();
  const close = () => (app.modal = null);
  const focus = (node: HTMLElement) => node.focus();
</script>

<div class="back" onpointerdown={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
  <div class="modal" class:wide role="dialog" aria-modal="true" aria-label={title} tabindex="-1" use:focus>
    <header>
      <h2>{title}</h2>
      <button class="btn ghost sq" onclick={close} aria-label="Close"><Icon name="x" /></button>
    </header>
    <div class="body">{@render children()}</div>
  </div>
</div>

<style>
  .back {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 16px;
    background: rgb(0 0 0 / 0.5); backdrop-filter: blur(6px);
    animation: fade 0.15s ease-out;
  }
  .modal {
    width: min(520px, 100%); max-height: min(86vh, 760px); display: flex; flex-direction: column;
    background: var(--panel); border-radius: 22px; border: 1px solid var(--line);
    box-shadow: 0 40px 80px -20px rgb(0 0 0 / 0.6), inset 0 1px 0 var(--hi);
    animation: pop 0.22s cubic-bezier(.2,.9,.3,1.2); outline: none;
  }
  .modal.wide { width: min(720px, 100%); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px 22px; }
  h2 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  .body { padding: 6px 22px 22px; overflow-y: auto; user-select: text; -webkit-user-select: text; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: translateY(14px) scale(0.96); } }
</style>
