<script lang="ts">
  import { importSample, toast } from '../actions.svelte';
  import { addSampleFolder, listSamples, readSample, removeSampleFolder, sampleFolders, type DiskSample } from '../desktop';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  // Desktop only: browse folders of samples on disk and put them on tracks.
  let folders = $state<string[]>([]);
  let folder = $state('');
  let files = $state<DiskSample[]>([]);
  let filter = $state('');
  let busy = $state('');
  const shown = $derived(files.filter((f) => f.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 400));
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const kb = (n: number) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function open(f: string): Promise<void> {
    folder = f;
    filter = '';
    try { files = await listSamples(f); } catch (e) { files = []; toast(String(e), 'error'); }
  }
  async function refresh(): Promise<void> {
    folders = await sampleFolders();
    if (folders.length && !folders.includes(folder)) await open(folders[0]);
    if (!folders.length) { folder = ''; files = []; }
  }
  async function add(): Promise<void> {
    try {
      const made = await addSampleFolder();
      await refresh();
      if (made) await open(made);
    } catch (e) { toast(String(e), 'error'); }
  }
  async function remove(f: string): Promise<void> {
    await removeSampleFolder(f);
    await refresh();
  }
  /** Load a file onto the selected track; it plays once so you hear what you picked. */
  async function use(f: DiskSample): Promise<void> {
    busy = f.path;
    try {
      const bytes = await readSample(f.path);
      await importSample(new File([bytes as unknown as BlobPart], base(f.name)), app.sel);
    } catch (e) { toast(String(e), 'error'); }
    busy = '';
  }
  void refresh();
</script>

<Modal title="Sample folders" wide>
  <div class="bar">
    {#each folders as f}
      <span class="tab" class:on={folder === f}>
        <button onclick={() => open(f)} title={f}>{base(f)}</button>
        <button class="x" onclick={() => remove(f)} aria-label="Forget folder {base(f)}">×</button>
      </span>
    {/each}
    <button class="btn" onclick={add}><Icon name="plus" size={13} />Add a folder</button>
  </div>
  {#if !folders.length}
    <p>Point Loopwell at a folder of sounds on this computer. Everything in it (and in folders inside it) shows up here, ready to drop onto a track. Nothing is copied or uploaded.</p>
  {:else}
    <input bind:value={filter} placeholder="Filter {files.length} sounds" aria-label="Filter sounds" spellcheck="false" />
    <div class="list">
      {#each shown as f (f.path)}
        <button class="file" class:busy={busy === f.path} onclick={() => use(f)} title="Use on {app.project.tracks[app.sel].name}">
          <Icon name="wave" size={14} /><span>{f.name}</span><small>{kb(f.size)}</small>
        </button>
      {:else}
        <p>{files.length ? 'Nothing matches.' : 'No audio files in this folder.'}</p>
      {/each}
    </div>
    <small class="hint">Click a sound to put it on <b>{app.project.tracks[app.sel].name}</b>.</small>
  {/if}
</Modal>

<style>
  p { margin: 10px 0; font-size: 14px; line-height: 1.45; color: var(--dim); }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
  .tab { display: inline-flex; align-items: center; height: 30px; border-radius: 9px; background: var(--inset); overflow: hidden; }
  .tab button { border: 0; background: none; height: 100%; padding: 0 9px; font: 600 11px var(--mono); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab .x { padding: 0 8px 0 2px; color: var(--dim); font-size: 14px; }
  .tab.on { background: var(--ink); }
  .tab.on button { color: var(--panel); }
  .btn { height: 30px; font-size: 10px; }
  input {
    width: 100%; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  .list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; max-height: 46vh; overflow-y: auto; }
  .file { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 0; border-radius: 8px; background: none; text-align: left; font: 600 12px var(--mono); }
  .file:hover { background: var(--inset); }
  .file span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file small { color: var(--dim); font-size: 10px; }
  .file.busy { opacity: 0.5; }
  .hint { display: block; margin-top: 10px; font: 600 11px var(--mono); color: var(--dim); }
</style>
