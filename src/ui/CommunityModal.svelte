<script lang="ts">
  import { toast } from '../actions.svelte';
  import {
    LICENSES, REPORT_REASONS, api,
    type Beat, type CloudProject, type CloudVersion, type Pack, type Profile, type Report,
  } from '../community/api';
  import { community, connect, devLogin, disconnect, fail, keyName, openBeat, openCloud, publish, refreshMe, saveToCloud, signIn, signOut, usePackSample } from '../community/store.svelte';
  import { app } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  type Tab = 'gallery' | 'cloud' | 'packs' | 'account' | 'admin';
  let tab = $state<Tab>('gallery');
  const me = $derived(community.me);
  const cfg = $derived(community.config);
  const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  const day = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // --- gallery ---
  let beats = $state<Beat[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let sort = $state<'new' | 'top' | 'plays'>('new');
  let search = $state('');
  let tag = $state('');
  let bpmMin = $state('');
  let bpmMax = $state('');
  let tags = $state<{ tag: string; count: number }[]>([]);
  let tagsAsked = false;
  let profile = $state<Profile | null>(null);
  let publishing = $state(false);
  let form = $state({ title: '', description: '', tags: '', genre: '' });

  async function load(more = false): Promise<void> {
    loading = true;
    try {
      const page = await api.beats({
        sort, q: search.trim(), tag, user: profile?.handle,
        bpmMin: +bpmMin || undefined, bpmMax: +bpmMax || undefined, cursor: more ? cursor : null,
      });
      beats = more ? [...beats, ...page.items] : page.items;
      cursor = page.nextCursor;
    } catch (e) { fail(e); }
    loading = false;
  }
  async function showProfile(handle: string | null): Promise<void> {
    try { profile = handle ? await api.profile(handle) : null; } catch (e) { fail(e); return; }
    await load();
  }
  async function like(b: Beat): Promise<void> {
    if (!me) { tab = 'account'; return; }
    try { Object.assign(b, await api.like(b.id, !b.likedByMe)); } catch (e) { fail(e); }
  }
  async function removeBeat(b: Beat): Promise<void> {
    try { await api.deleteBeat(b.id); beats = beats.filter((x) => x.id !== b.id); } catch (e) { fail(e); }
  }
  function startPublish(): void {
    if (!me) { tab = 'account'; return; }
    form = { title: app.project.name === 'untitled' ? '' : app.project.name, description: '', tags: '', genre: '' };
    publishing = true;
  }
  async function submitPublish(): Promise<void> {
    const beat = await publish(form);
    if (!beat) return;
    publishing = false;
    profile = null; sort = 'new';
    await load();
  }

  // --- reporting ---
  let reporting = $state<{ type: 'beat' | 'pack' | 'user'; id: string; label: string } | null>(null);
  let reason = $state<string>(REPORT_REASONS[0]);
  let details = $state('');
  function report(type: 'beat' | 'pack' | 'user', id: string, label: string): void {
    if (!me) { tab = 'account'; return; }
    reporting = { type, id, label };
    reason = REPORT_REASONS[0];
    details = '';
  }
  async function sendReport(): Promise<void> {
    if (!reporting) return;
    try { await api.report(reporting.type, reporting.id, reason, details); toast('Thanks. A moderator will take a look.'); reporting = null; } catch (e) { fail(e); }
  }

  // --- cloud saves ---
  let saves = $state<CloudProject[]>([]);
  let versionsOf = $state<string | null>(null);
  let versions = $state<CloudVersion[]>([]);
  async function loadSaves(): Promise<void> {
    if (!me) return;
    try { saves = (await api.projects()).items; } catch (e) { fail(e); }
  }
  async function save(asNew: boolean): Promise<void> {
    if (await saveToCloud(asNew)) await loadSaves();
  }
  async function toggleVersions(p: CloudProject): Promise<void> {
    if (versionsOf === p.id) { versionsOf = null; return; }
    try { versions = (await api.versions(p.id)).items; versionsOf = p.id; } catch (e) { fail(e); }
  }
  async function restore(p: CloudProject, n: number): Promise<void> {
    try { await api.restore(p.id, n); toast(`Version ${n} is the newest again`); versionsOf = null; await loadSaves(); } catch (e) { fail(e); }
  }
  async function removeSave(p: CloudProject): Promise<void> {
    try {
      await api.deleteProject(p.id);
      if (community.cloud?.id === p.id) community.cloud = null;
      await loadSaves();
      void refreshMe();
    } catch (e) { fail(e); }
  }

  // --- sample packs ---
  let packs = $state<Pack[]>([]);
  let pack = $state<Pack | null>(null);
  let mine = $state(false);
  let packSearch = $state('');
  let creating = $state(false);
  let packForm = $state({ name: '', description: '', license: LICENSES[0] as string, licenseUrl: '', attribution: '', tags: '' });
  let uploader = $state<HTMLInputElement>();
  async function loadPacks(): Promise<void> {
    try { packs = (await api.packs({ q: packSearch.trim(), mine: mine ? 1 : undefined })).items; } catch (e) { fail(e); }
  }
  async function openPack(id: string): Promise<void> {
    try { pack = await api.pack(id); } catch (e) { fail(e); }
  }
  async function createPack(): Promise<void> {
    try {
      const made = await api.createPack({
        name: packForm.name, description: packForm.description, license: packForm.license,
        licenseUrl: packForm.license === 'custom' ? packForm.licenseUrl : undefined, attribution: packForm.attribution || undefined,
        tags: packForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      creating = false;
      mine = true;
      await openPack(made.id);
    } catch (e) { fail(e); }
  }
  async function upload(e: Event): Promise<void> {
    const el = e.currentTarget as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    if (!pack) return;
    for (const f of files) {
      // the server enforces the limits; checking here first saves a pointless upload
      if (cfg && f.size > cfg.limits.sampleBytes) { toast(`${f.name} is over the ${mb(cfg.limits.sampleBytes)} limit.`, 'error'); continue; }
      try { await api.addSample(pack.id, f.name, new Uint8Array(await f.arrayBuffer())); } catch (err) { fail(err); }
    }
    await openPack(pack.id);
    void refreshMe();
  }
  async function removeSample(sid: string): Promise<void> {
    if (!pack) return;
    try { await api.removeSample(pack.id, sid); await openPack(pack.id); } catch (e) { fail(e); }
  }
  async function publishPack(): Promise<void> {
    if (!pack) return;
    try { await api.publishPack(pack.id); await openPack(pack.id); toast('Pack published'); } catch (e) { fail(e); }
  }
  async function removePack(): Promise<void> {
    if (!pack) return;
    try { await api.deletePack(pack.id); pack = null; await loadPacks(); void refreshMe(); } catch (e) { fail(e); }
  }

  // --- account ---
  let address = $state('');
  let handle = $state('');
  let edit = $state({ displayName: '', bio: '' });
  let confirmDelete = $state(false);
  $effect(() => { if (me) edit = { displayName: me.displayName, bio: me.bio }; });
  async function saveProfile(): Promise<void> {
    try { community.me = { ...me!, ...(await api.updateMe(edit)) }; toast('Profile saved'); } catch (e) { fail(e); }
  }
  async function deleteAccount(): Promise<void> {
    try { await api.deleteMe(); await signOut(); toast('Your account and everything in it has been deleted.'); } catch (e) { fail(e); }
  }

  // --- moderation ---
  let reports = $state<Report[]>([]);
  let status = $state<'open' | 'resolved'>('open');
  let note = $state('');
  let audit = $state<{ id: string; admin: string; action: string; targetType: string; targetId: string; note: string | null; createdAt: string }[]>([]);
  async function loadReports(): Promise<void> {
    try { reports = (await api.reports(status)).items; audit = (await api.audit()).items.slice(0, 20); } catch (e) { fail(e); }
  }
  async function resolve(r: Report, action: string): Promise<void> {
    try { await api.resolve(r.id, action, note); note = ''; await loadReports(); } catch (e) { fail(e); }
  }
  async function undo(r: Report): Promise<void> {
    try {
      if (r.targetType === 'user') await api.unban(r.targetId);
      else await api.unhide(r.targetType === 'beat' ? 'beats' : 'packs', r.targetId);
      await loadReports();
    } catch (e) { fail(e); }
  }

  $effect(() => {
    if (!community.server || !cfg) return;
    if (tab === 'gallery') {
      void sort; void tag;
      void load();
      // asked for once: an empty answer must not look like "not asked yet"
      if (!tagsAsked) { tagsAsked = true; void api.tags().then((t) => (tags = t.items.slice(0, 14)), () => {}); }
    }
    else if (tab === 'cloud') void loadSaves();
    else if (tab === 'packs') { void mine; void loadPacks(); }
    else if (tab === 'admin') { void status; void loadReports(); }
  });
</script>

<Modal title="Community" wide>
  {#if !community.server}
    <p>Loopwell works on its own, with nothing stored anywhere but this browser. If you or someone you know runs a Loopwell server, connect to it for accounts, cloud saves, a gallery of published beats and shared sample packs.</p>
    <form class="line" onsubmit={(e) => { e.preventDefault(); connect(address); }}>
      <input bind:value={address} placeholder="https://loopwell.example.com" aria-label="Server address" spellcheck="false" />
      <button class="btn on" disabled={!address.trim()}>Connect</button>
    </form>
  {:else if !cfg}
    <p>Could not reach <b>{community.server}</b>. It may be down, or not allow this site.</p>
    <button class="btn" onclick={() => { disconnect(); }}>Forget this server</button>
  {:else}
    <div class="seg tabs" role="tablist">
      <button role="tab" class:on={tab === 'gallery'} onclick={() => (tab = 'gallery')}>Gallery</button>
      <button role="tab" class:on={tab === 'cloud'} onclick={() => (tab = 'cloud')}>My saves</button>
      <button role="tab" class:on={tab === 'packs'} onclick={() => (tab = 'packs')}>Sample packs</button>
      <button role="tab" class:on={tab === 'account'} onclick={() => (tab = 'account')}>{me ? me.displayName : 'Sign in'}</button>
      {#if me?.isAdmin}<button role="tab" class:on={tab === 'admin'} onclick={() => (tab = 'admin')}>Moderation</button>{/if}
    </div>

    {#if reporting}
      <form class="card" onsubmit={(e) => { e.preventDefault(); void sendReport(); }}>
        <b>Report “{reporting.label}”</b>
        <div class="line">
          <select class="pick" bind:value={reason} aria-label="Reason">{#each REPORT_REASONS as r}<option value={r}>{r}</option>{/each}</select>
          <input bind:value={details} maxlength="1000" placeholder="What is wrong with it?" aria-label="Details" />
        </div>
        <div class="line"><button class="btn on">Send report</button><button type="button" class="btn ghost" onclick={() => (reporting = null)}>Cancel</button></div>
      </form>
    {/if}

    {#if tab === 'gallery'}
      {#if publishing}
        <form class="card" onsubmit={(e) => { e.preventDefault(); void submitPublish(); }}>
          <b>Publish this beat</b>
          {#if community.origin}<small>Published as a remix of “{community.origin.title}” by {community.origin.author.displayName}, with credit.</small>{/if}
          <input bind:value={form.title} maxlength="80" placeholder="Title" aria-label="Title" required />
          <input bind:value={form.description} maxlength="500" placeholder="A line about it (optional)" aria-label="Description" />
          <div class="line">
            <input bind:value={form.genre} maxlength="32" placeholder="Genre" aria-label="Genre" />
            <input bind:value={form.tags} maxlength="120" placeholder="Tags, comma separated" aria-label="Tags" />
          </div>
          <small>{app.project.bpm} bpm · {keyName()} · anyone can open and remix what you publish.</small>
          <div class="line"><button class="btn on" disabled={!form.title.trim()}>Publish</button><button type="button" class="btn ghost" onclick={() => (publishing = false)}>Cancel</button></div>
        </form>
      {:else}
        {#if profile}
          <div class="card who">
            {#if profile.avatarUrl}<img src={profile.avatarUrl} alt="" width="44" height="44" />{/if}
            <div>
              <b>{profile.displayName}</b> <small>@{profile.handle} · joined {day(profile.joinedAt)}</small>
              {#if profile.bio}<p>{profile.bio}</p>{/if}
              <small>{profile.beatCount} beats · {profile.totalPlays} plays · {profile.totalLikes} likes</small>
            </div>
            <span class="grow"></span>
            <button class="btn ghost" onclick={() => report('user', profile!.handle, profile!.displayName)}>Report</button>
            <button class="btn" onclick={() => showProfile(null)}>All beats</button>
          </div>
        {:else}
          <div class="line">
            <input bind:value={search} placeholder="Search beats" aria-label="Search beats" onkeydown={(e) => { if (e.key === 'Enter') void load(); }} />
            <input class="narrow" bind:value={bpmMin} inputmode="numeric" placeholder="bpm from" aria-label="Slowest tempo" onchange={() => load()} />
            <input class="narrow" bind:value={bpmMax} inputmode="numeric" placeholder="to" aria-label="Fastest tempo" onchange={() => load()} />
            <div class="seg">
              <button class:on={sort === 'new'} onclick={() => (sort = 'new')}>New</button>
              <button class:on={sort === 'top'} onclick={() => (sort = 'top')}>Liked</button>
              <button class:on={sort === 'plays'} onclick={() => (sort = 'plays')}>Played</button>
            </div>
            <button class="btn on" onclick={startPublish}><Icon name="share" size={13} />Publish</button>
          </div>
          {#if tags.length}
            <div class="chips">
              {#each tags as t}<button class="chip" class:on={tag === t.tag} onclick={() => (tag = tag === t.tag ? '' : t.tag)}>#{t.tag}</button>{/each}
            </div>
          {/if}
        {/if}
        <div class="list">
          {#each beats as b (b.id)}
            <div class="beat" class:hidden={b.hidden}>
              <button class="playb" onclick={() => openBeat(b, false)} aria-label="Play {b.title}"><Icon name="play" size={15} fill /></button>
              <div class="meta">
                <b>{b.title}</b>
                <small>
                  by <button class="link" onclick={() => showProfile(b.author.handle)}>{b.author.displayName}</button>
                  {#if b.remixOf} · remix of “{b.remixOf.title}” by <button class="link" onclick={() => showProfile(b.remixOf!.author.handle)}>{b.remixOf.author.displayName}</button>{/if}
                  {#if b.hidden} · hidden by a moderator{/if}
                </small>
                <small>{[b.bpm ? `${b.bpm} bpm` : '', b.key, b.genre, ...b.tags.map((t) => `#${t}`)].filter(Boolean).join(' · ')}</small>
                {#if b.description}<small class="desc">{b.description}</small>{/if}
              </div>
              <span class="stat" title="Plays">▶ {b.plays}</span>
              <button class="stat like" class:on={b.likedByMe} onclick={() => like(b)} aria-pressed={b.likedByMe} aria-label="Like {b.title}">♥ {b.likes}</button>
              <button class="btn" onclick={() => openBeat(b, true)} title="Open a copy of your own. Publishing it credits {b.author.displayName}.">Remix{b.remixCount ? ` · ${b.remixCount}` : ''}</button>
              {#if me && (me.handle === b.author.handle || me.isAdmin)}
                <button class="btn ghost sq" onclick={() => removeBeat(b)} aria-label="Delete {b.title}"><Icon name="trash" size={13} /></button>
              {:else}
                <button class="btn ghost sq" onclick={() => report('beat', b.id, b.title)} aria-label="Report {b.title}" title="Report">!</button>
              {/if}
            </div>
          {:else}
            <p class="none">{loading ? 'Loading…' : 'Nothing here yet. Be the first to publish a beat.'}</p>
          {/each}
        </div>
        {#if cursor}<button class="btn more" onclick={() => load(true)} disabled={loading}>Show more</button>{/if}
      {/if}

    {:else if tab === 'cloud'}
      {#if !me}
        <p class="none">Sign in to keep beats on the server and get them back on any device.</p>
        <button class="btn on" onclick={() => (tab = 'account')}>Sign in</button>
      {:else}
        <div class="line">
          <button class="btn on" onclick={() => save(false)}>{community.cloud ? `Save a new version of “${community.cloud.name}”` : `Save “${app.project.name}” to the cloud`}</button>
          {#if community.cloud}<button class="btn" onclick={() => save(true)}>Save as a new project</button>{/if}
          <span class="grow"></span>
          {#if me.storage}<small>{mb(me.storage.used)} of {mb(me.storage.quota)} used</small>{/if}
        </div>
        <div class="list">
          {#each saves as p (p.id)}
            <div class="beat" class:cur={community.cloud?.id === p.id}>
              <div class="meta">
                <b>{p.name}</b>
                <small>version {p.version} · {mb(p.size)} · saved {day(p.updatedAt)}</small>
              </div>
              <button class="btn" onclick={() => openCloud(p)}>Open</button>
              <button class="btn ghost" onclick={() => toggleVersions(p)} aria-expanded={versionsOf === p.id}>History · {p.versionCount}</button>
              <button class="btn ghost sq" onclick={() => removeSave(p)} aria-label="Delete {p.name}"><Icon name="trash" size={13} /></button>
            </div>
            {#if versionsOf === p.id}
              <div class="versions">
                {#each versions as v}
                  <div class="ver">
                    <span>Version {v.n}{v.current ? ' (current)' : ''}</span><small>{day(v.createdAt)} · {mb(v.size)}</small>
                    <span class="grow"></span>
                    <button class="btn ghost" onclick={() => openCloud(p, v.n)}>Open</button>
                    {#if !v.current}<button class="btn ghost" onclick={() => restore(p, v.n)}>Restore</button>{/if}
                  </div>
                {/each}
              </div>
            {/if}
          {:else}
            <p class="none">No saves yet. Each save keeps the earlier versions, up to {cfg.limits.projectVersions} of them.</p>
          {/each}
        </div>
      {/if}

    {:else if tab === 'packs'}
      {#if creating}
        <form class="card" onsubmit={(e) => { e.preventDefault(); void createPack(); }}>
          <b>New sample pack</b>
          <input bind:value={packForm.name} maxlength="80" placeholder="Name" aria-label="Pack name" required />
          <input bind:value={packForm.description} maxlength="500" placeholder="What is in it (optional)" aria-label="Pack description" />
          <div class="line">
            <select class="pick" bind:value={packForm.license} aria-label="License">{#each LICENSES as l}<option value={l}>{l === 'custom' ? 'Other license' : l}</option>{/each}</select>
            {#if packForm.license === 'custom'}<input bind:value={packForm.licenseUrl} type="url" placeholder="Link to the license text" aria-label="License link" required />{/if}
            <input bind:value={packForm.attribution} maxlength="200" placeholder="Credit as (optional)" aria-label="Attribution" />
          </div>
          <input bind:value={packForm.tags} maxlength="120" placeholder="Tags, comma separated" aria-label="Pack tags" />
          <small>Only upload sounds you made or are allowed to share under this license.</small>
          <div class="line"><button class="btn on" disabled={!packForm.name.trim()}>Create</button><button type="button" class="btn ghost" onclick={() => (creating = false)}>Cancel</button></div>
        </form>
      {:else if pack}
        <div class="card">
          <div class="line">
            <b>{pack.name}</b><small>by {pack.author.displayName} · {pack.license}{pack.attribution ? ` · credit ${pack.attribution}` : ''}{pack.published ? '' : ' · draft'}</small>
            <span class="grow"></span>
            <button class="btn" onclick={() => { pack = null; void loadPacks(); }}>All packs</button>
          </div>
          {#if pack.description}<p>{pack.description}</p>{/if}
          {#if pack.licenseUrl}<small><a href={pack.licenseUrl} target="_blank" rel="noreferrer">License terms</a></small>{/if}
          {#if me?.handle === pack.author.handle}
            <div class="line">
              <button class="btn" onclick={() => uploader?.click()}><Icon name="open" size={13} />Add samples</button>
              <input bind:this={uploader} type="file" accept="audio/*,.wav,.aiff,.mp3,.ogg,.flac,.m4a" multiple hidden onchange={upload} />
              {#if !pack.published}<button class="btn on" disabled={!pack.samples?.length} onclick={publishPack}>Publish pack</button>{/if}
              <button class="btn ghost" onclick={removePack}>Delete pack</button>
              <small>Up to {cfg.limits.packFiles} files, {mb(cfg.limits.sampleBytes)} and {cfg.limits.sampleSeconds}s each.</small>
            </div>
          {:else}
            <button class="btn ghost" onclick={() => report('pack', pack!.id, pack!.name)}>Report this pack</button>
          {/if}
        </div>
        <div class="list">
          {#each pack.samples ?? [] as s (s.id)}
            <div class="beat">
              <div class="meta"><b>{s.name}</b><small>{s.format} · {mb(s.size)}{s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''}</small></div>
              <button class="btn" onclick={() => usePackSample(pack!, s)}>Use on {app.project.tracks[app.sel].name}</button>
              {#if me?.handle === pack.author.handle}<button class="btn ghost sq" onclick={() => removeSample(s.id)} aria-label="Remove {s.name}"><Icon name="trash" size={13} /></button>{/if}
            </div>
          {:else}
            <p class="none">No samples in this pack yet.</p>
          {/each}
        </div>
      {:else}
        <div class="line">
          <input bind:value={packSearch} placeholder="Search packs" aria-label="Search packs" onkeydown={(e) => { if (e.key === 'Enter') void loadPacks(); }} />
          {#if me}
            <div class="seg"><button class:on={!mine} onclick={() => (mine = false)}>All</button><button class:on={mine} onclick={() => (mine = true)}>Mine</button></div>
            <button class="btn on" onclick={() => { creating = true; packForm = { name: '', description: '', license: LICENSES[0], licenseUrl: '', attribution: '', tags: '' }; }}><Icon name="plus" size={13} />New pack</button>
          {/if}
        </div>
        <div class="list">
          {#each packs as k (k.id)}
            <div class="beat">
              <div class="meta">
                <b>{k.name}</b>
                <small>by {k.author.displayName} · {k.sampleCount} samples · {k.license}{k.published ? '' : ' · draft'}{k.hidden ? ' · hidden by a moderator' : ''}</small>
                {#if k.description}<small class="desc">{k.description}</small>{/if}
              </div>
              <button class="btn" onclick={() => openPack(k.id)}>Open</button>
            </div>
          {:else}
            <p class="none">No sample packs yet.</p>
          {/each}
        </div>
      {/if}

    {:else if tab === 'account'}
      {#if me}
        <form class="card" onsubmit={(e) => { e.preventDefault(); void saveProfile(); }}>
          <div class="who">
            {#if me.avatarUrl}<img src={me.avatarUrl} alt="" width="44" height="44" />{/if}
            <div><b>@{me.handle}</b>{#if me.storage}<br /><small>{mb(me.storage.used)} of {mb(me.storage.quota)} used</small>{/if}</div>
            <span class="grow"></span>
            <button type="button" class="btn" onclick={() => { tab = 'gallery'; void showProfile(me!.handle); }}>My profile</button>
          </div>
          <input bind:value={edit.displayName} maxlength="60" placeholder="Display name" aria-label="Display name" />
          <input bind:value={edit.bio} maxlength="300" placeholder="A line about you" aria-label="Bio" />
          <div class="line">
            <button class="btn on">Save profile</button>
            <button type="button" class="btn" onclick={signOut}>Sign out</button>
            <span class="grow"></span>
            {#if confirmDelete}
              <button type="button" class="btn danger" onclick={deleteAccount}>Yes, delete everything</button>
              <button type="button" class="btn ghost" onclick={() => (confirmDelete = false)}>Keep it</button>
            {:else}
              <button type="button" class="btn ghost" onclick={() => (confirmDelete = true)}>Delete account</button>
            {/if}
          </div>
        </form>
      {:else}
        <p>Signing in lets you save beats to the server, publish them, like and remix other people's, and share sample packs. Making and sharing beats by link never needs an account.</p>
        <div class="line">
          {#each cfg.providers as provider}
            <button class="btn on" onclick={() => signIn(provider)}>Sign in with {provider === 'github' ? 'GitHub' : 'Discord'}</button>
          {/each}
          {#if !cfg.providers.length && !cfg.devLogin}<small>This server has no sign-in method set up yet.</small>{/if}
        </div>
        {#if cfg.devLogin}
          <form class="line" onsubmit={(e) => { e.preventDefault(); void devLogin(handle); }}>
            <input bind:value={handle} maxlength="28" placeholder="Test account name" aria-label="Test account name" />
            <button class="btn" disabled={!handle.trim()}>Development sign-in</button>
          </form>
        {/if}
      {/if}
      <small class="server">Server: {community.server} · <button class="link" onclick={disconnect}>disconnect</button></small>

    {:else if tab === 'admin'}
      <div class="line">
        <div class="seg"><button class:on={status === 'open'} onclick={() => (status = 'open')}>Open</button><button class:on={status === 'resolved'} onclick={() => (status = 'resolved')}>Resolved</button></div>
        <input bind:value={note} maxlength="500" placeholder="Note for the log (optional)" aria-label="Moderator note" />
      </div>
      <div class="list">
        {#each reports as r (r.id)}
          <div class="beat">
            <div class="meta">
              <b>{r.targetType}: {r.target.label ?? '(deleted)'}</b>
              <small>{r.reason} · reported by @{r.reporter} · {day(r.createdAt)}{r.target.owner ? ` · owner @${r.target.owner}` : ''}</small>
              {#if r.details}<small class="desc">{r.details}</small>{/if}
              {#if r.status === 'resolved'}<small>{r.resolution} by @{r.resolvedBy}{r.note ? `: ${r.note}` : ''}</small>{/if}
            </div>
            {#if r.status === 'open'}
              <button class="btn ghost" onclick={() => resolve(r, 'dismiss')}>Dismiss</button>
              {#if r.targetType !== 'user'}
                <button class="btn" onclick={() => resolve(r, 'hide')}>Hide</button>
                <button class="btn" onclick={() => resolve(r, 'remove')}>Remove</button>
              {/if}
              <button class="btn danger" onclick={() => resolve(r, 'ban')}>Ban {r.targetType === 'user' ? 'user' : 'owner'}</button>
            {:else if r.target.hidden || r.target.banned}
              <button class="btn" onclick={() => undo(r)}>{r.targetType === 'user' ? 'Unban' : 'Unhide'}</button>
            {/if}
          </div>
        {:else}
          <p class="none">No {status} reports.</p>
        {/each}
      </div>
      {#if audit.length}
        <h3>Recent moderator actions</h3>
        <div class="log">{#each audit as a}<div>{day(a.createdAt)} · @{a.admin} · {a.action} · {a.targetType} {a.targetId}{a.note ? ` · ${a.note}` : ''}</div>{/each}</div>
      {/if}
    {/if}
  {/if}
</Modal>

<style>
  p { margin: 6px 0 12px; font-size: 14px; line-height: 1.45; }
  .tabs { margin: 2px 0 14px; flex-wrap: wrap; }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grow { flex: 1; }
  input {
    flex: 1; min-width: 120px; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset);
    font: 600 12px var(--mono); user-select: text; -webkit-user-select: text;
  }
  input.narrow { flex: 0 0 84px; min-width: 0; }
  .btn { height: 30px; font-size: 10px; padding: 0 10px; white-space: nowrap; }
  .btn.sq { padding: 0; width: 30px; }
  .btn.danger { background: var(--rec); color: #fff; border-color: transparent; }
  small { font: 600 11px var(--mono); color: var(--dim); }
  .card { display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-bottom: 12px; border-radius: 14px; background: var(--inset); }
  .card input { background: var(--panel); flex: none; }
  .card .line input { flex: 1; }
  .card p { margin: 0; font-size: 13px; }
  .who { display: flex; align-items: center; gap: 10px; flex-direction: row; }
  .who img { border-radius: 50%; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 0 0; }
  .chip { height: 22px; padding: 0 8px; border-radius: 11px; border: 1px solid var(--line); background: var(--raise); font: 600 10px var(--mono); color: var(--dim); }
  .chip.on { background: var(--ink); color: var(--panel); border-color: transparent; }
  .list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .beat { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--raise); }
  .beat.hidden { opacity: 0.6; }
  .beat.cur { border-color: var(--accent); }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .meta b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta .desc { white-space: normal; font-family: var(--font); font-weight: 500; }
  .playb { flex: none; width: 36px; height: 36px; border-radius: 11px; border: 0; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; }
  .stat { font: 700 11px var(--mono); color: var(--dim); border: 0; background: none; padding: 0 2px; white-space: nowrap; }
  .like.on { color: var(--rec); }
  .link { border: 0; background: none; padding: 0; font: inherit; color: var(--ink); text-decoration: underline; }
  .none { color: var(--dim); font-size: 13px; margin: 14px 2px; }
  .more { margin: 12px auto 0; display: flex; }
  .versions { margin: -2px 0 4px 16px; display: flex; flex-direction: column; gap: 2px; }
  .ver { display: flex; align-items: center; gap: 10px; font: 600 12px var(--mono); padding: 2px 8px; }
  .server { display: block; margin-top: 16px; }
  h3 { margin: 18px 0 6px; font: 700 10px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .log { font: 500 11px/1.6 var(--mono); color: var(--dim); }
  @media (max-width: 560px) { .beat { flex-wrap: wrap; } .meta { flex-basis: 60%; } }
</style>
