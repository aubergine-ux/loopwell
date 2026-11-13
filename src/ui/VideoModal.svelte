<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMix } from '../actions.svelte';
  import { app } from '../state.svelte';
  import { cancelVideo, chooseCover, clearCover, coverImage, exportVideo, sceneFor, video, videoBusy } from '../video.svelte';
  import { FPS, VIDEO_SIZES, VIDEO_STYLES, drawFrame, type Scene, type VideoSize } from '../video/draw';
  import { lively } from '../visual';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let canvas = $state<HTMLCanvasElement>();
  let picker = $state<HTMLInputElement>();
  let scene: Scene | null = null;
  let ready = $state(false);
  const busy = $derived(videoBusy());
  const size = $derived(VIDEO_SIZES[video.size]);

  if (!video.title) video.title = app.project.name === 'untitled' ? '' : app.project.name;

  onMount(() => {
    let raf = 0, alive = true;
    const began = performance.now();
    // the preview plays the first few seconds of the beat, silently, in a loop
    void renderMix(undefined, 8).then((mix) => {
      if (!alive) return;
      scene = sceneFor(mix);
      ready = true;
    });
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const c = canvas;
      if (!c || !scene || busy) return;
      // what was picked since the scene was made
      scene.style = video.style;
      scene.title = video.showTitle ? video.title.trim() : '';
      scene.tag = video.tag.trim();
      const { w, h } = VIDEO_SIZES[video.size];
      // drawn at a quarter of the real size, which is plenty for a preview
      const scale = 0.25;
      if (c.width !== w * scale || c.height !== h * scale) { c.width = w * scale; c.height = h * scale; }
      const g = c.getContext('2d')!;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      const t = lively() ? ((now - began) / 1000) % Math.max(0.5, scene.seconds) : Math.min(1, scene.seconds / 2);
      drawFrame(g, w, h, Math.floor(t * FPS) / FPS, scene);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); cancelVideo(); };
  });

  function pick(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = '';
    // a scene holds the picture it was made with, so it is given the new one
    if (f) void chooseCover(f).then(() => { if (scene) scene = { ...scene, cover: coverImage() }; });
  }
  function dropCover(): void {
    clearCover();
    if (scene) scene = { ...scene, cover: null };
  }
  async function make(): Promise<void> {
    if (await exportVideo()) app.modal = null;
  }
  const names: Record<VideoSize, string> = { vertical: 'Tall', wide: 'Wide', square: 'Square' };
</script>

<Modal title="Video" wide>
  <div class="video">
    <div class="stage" style:aspect-ratio="{size.w} / {size.h}" class:tall={video.size === 'vertical'}>
      <canvas bind:this={canvas} aria-label="Preview of the video"></canvas>
      {#if !ready}<span class="wait">Getting a preview ready…</span>{/if}
    </div>

    <div class="opts">
      <div class="field">
        <span class="label">Shape</span>
        <div class="seg" role="radiogroup" aria-label="Shape of the video">
          {#each Object.keys(VIDEO_SIZES) as k}
            {@const s = VIDEO_SIZES[k as VideoSize]}
            <button class:on={video.size === k} role="radio" aria-checked={video.size === k} disabled={busy} onclick={() => (video.size = k as VideoSize)}
              title="{s.label}: {s.w} × {s.h}">{names[k as VideoSize]} <small>{s.ratio}</small></button>
          {/each}
        </div>
        <span class="hint">{size.label} · {size.w} × {size.h}</span>
      </div>

      <div class="field">
        <span class="label">Picture</span>
        <div class="seg" role="radiogroup" aria-label="What the video shows">
          {#each VIDEO_STYLES as s}
            <button class:on={video.style === s.id} role="radio" aria-checked={video.style === s.id} disabled={busy} onclick={() => (video.style = s.id)}>{s.label}</button>
          {/each}
        </div>
        {#if video.style === 'cover'}
          <div class="row">
            <button class="btn" onclick={() => picker?.click()} disabled={busy}><Icon name="open" size={13} />{video.coverName ? 'Another picture' : 'Choose a picture'}</button>
            {#if video.coverName}
              <span class="hint name">{video.coverName}</span>
              <button class="btn ghost sq" onclick={dropCover} aria-label="Remove the cover picture" disabled={busy}><Icon name="x" size={13} /></button>
            {:else}
              <span class="hint">Without one, a cover is made from the beat's colours.</span>
            {/if}
          </div>
        {/if}
        <input bind:this={picker} type="file" accept="image/*" hidden onchange={pick} />
      </div>

      <div class="field">
        <label class="check"><input type="checkbox" bind:checked={video.showTitle} disabled={busy} /> <span class="label">Title</span></label>
        <input class="text" bind:value={video.title} maxlength="60" placeholder="Name of the beat" aria-label="Title shown in the video" disabled={busy || !video.showTitle} spellcheck="false" />
      </div>
      <div class="field">
        <span class="label">Tag</span>
        <input class="text" bind:value={video.tag} maxlength="60" placeholder="prod. your name (optional)" aria-label="Producer tag shown in the video" disabled={busy} spellcheck="false" />
      </div>

      {#if busy}
        <div class="progress" role="status" aria-live="polite">
          <div class="what"><b>{video.stage === 'audio' ? 'Rendering the sound' : 'Filming'}</b><span>{Math.round(video.progress * 100)}%</span></div>
          <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(video.progress * 100)} aria-label="Making the video"><i style:width="{Math.round(video.progress * 100)}%"></i></div>
          <button class="btn" onclick={cancelVideo}>Cancel</button>
        </div>
      {:else}
        {#if video.error}<p class="error" role="alert">{video.error}</p>{/if}
        <button class="btn on go" onclick={make}>Make the video</button>
        <p class="small">An MP4 of {app.project.songMode ? 'the whole song' : 'the pattern on screen, once through'}, in the colours of the theme you are using.
          It is made on this device, which can take a while for a long song.</p>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .video { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 18px; align-items: start; }
  .stage { position: relative; width: 100%; max-height: 56vh; border-radius: 12px; overflow: hidden; background: var(--inset); justify-self: center; }
  .stage.tall { width: auto; height: 56vh; max-width: 100%; }
  canvas { width: 100%; height: 100%; display: block; }
  .wait { position: absolute; inset: 0; display: grid; place-items: center; font: 600 11px var(--mono); color: var(--dim); text-align: center; padding: 10px; }
  .opts { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .seg { flex-wrap: wrap; align-self: flex-start; }
  .seg button { min-width: 0; padding: 0 10px; }
  .seg small { font-size: 9px; opacity: 0.6; }
  .hint { font: 600 10px var(--mono); color: var(--dim); }
  .hint.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .row .btn { height: 28px; font-size: 10px; gap: 5px; flex: none; }
  .check { display: inline-flex; align-items: center; gap: 6px; }
  .text {
    height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text; min-width: 0;
  }
  .text:disabled { opacity: 0.5; }
  .go { height: 40px; }
  .small { margin: 0; font-size: 12px; line-height: 1.4; color: var(--dim); }
  .error { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--rec); color: var(--on-c); font-size: 13px; }
  .progress { display: flex; flex-direction: column; gap: 8px; }
  .what { display: flex; justify-content: space-between; font-size: 13px; }
  .what span { font: 600 11px var(--mono); color: var(--dim); }
  .bar { height: 8px; border-radius: 4px; background: var(--well); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width 150ms; }
  .progress .btn { align-self: flex-start; height: 30px; }
  @media (max-width: 640px) {
    .video { grid-template-columns: minmax(0, 1fr); }
    .stage, .stage.tall { height: 34vh; width: auto; max-width: 100%; }
  }
</style>
