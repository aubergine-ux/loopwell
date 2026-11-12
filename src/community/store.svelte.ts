// Sign-in, the gallery, cloud saves and sample packs. All of it is optional:
// with no server configured, `community.server` stays empty and none of the
// interface for it is shown.

import { importSample, loadHooks, openProjectBytes, play, projectFileBytes, toast } from '../actions.svelte';
import { NOTE_NAMES, SCALES } from '../core/scales';
import { app } from '../state.svelte';
import {
  ApiError, api, serverUrl, setServer, setToken, token, validServer,
  type Beat, type CloudProject, type Pack, type PackSample, type RemixCredit, type ServerConfig, type User,
} from './api';

export const community = $state({
  server: '',
  config: null as ServerConfig | null,
  me: null as User | null,
  /** The published beat the project on screen was opened from; publishing it again credits that beat. */
  origin: null as RemixCredit | null,
  /** The cloud save the project on screen belongs to. */
  cloud: null as { id: string; name: string; version: number } | null,
});

/** Show a server error as a toast and carry on. */
export function fail(e: unknown): void {
  toast(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.', 'error');
}

const AUTH_ERRORS: Record<string, string> = {
  access_denied: 'Sign-in was cancelled.',
  provider_error: 'The sign-in provider had a problem. Try again.',
  banned: 'This account has been banned.',
};

/** Runs once at startup: picks up a #server= or #auth= link, then loads who is signed in. */
let hooked = false;

export async function initCommunity(): Promise<void> {
  if (!hooked) {
    hooked = true;
    // a different beat on screen no longer belongs to the old gallery entry or cloud save
    loadHooks.push(() => { community.origin = null; community.cloud = null; });
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const clean = () => history.replaceState(null, '', location.pathname + location.search);
  const server = hash.get('server');
  if (server !== null) {
    clean();
    const ok = validServer(server);
    if (ok) { setServer(ok); toast(`Connected to ${new URL(ok).host}`); }
    else toast('That server address is not valid. It has to start with https://', 'error');
  }
  community.server = serverUrl();
  if (!community.server) return;
  const code = hash.get('auth'), authError = hash.get('auth_error');
  if (code || authError) clean();
  try {
    community.config = await api.config();
    if (code) {
      const s = await api.exchange(code);
      setToken(s.token);
      toast(`Signed in as ${s.user.displayName}`);
      app.modal = 'community';
    } else if (authError) toast(AUTH_ERRORS[authError] ?? 'Sign-in failed.', 'error');
    if (token()) community.me = await api.me();
  } catch (e) {
    // a server that is down must not get in the way of making music
    if (e instanceof ApiError && e.status === 401) community.me = null;
    else if (code) fail(e);
  }
}

export function connect(address: string): boolean {
  const ok = validServer(address.trim());
  if (!ok) { toast('That server address is not valid. It has to start with https://', 'error'); return false; }
  setServer(ok);
  community.me = null;
  community.config = null;
  void initCommunity();
  return true;
}

export function disconnect(): void {
  setServer('');
  community.server = serverUrl(); // a server set at build time stays
  community.me = null;
  community.config = null;
}

export function signIn(provider: string): void {
  location.href = api.startUrl(provider, location.origin + location.pathname);
}

export async function devLogin(handle: string): Promise<void> {
  try {
    const s = await api.devLogin(handle);
    setToken(s.token);
    community.me = await api.me();
  } catch (e) { fail(e); }
}

export async function signOut(): Promise<void> {
  try { await api.logout(); } catch { /* the token is dropped either way */ }
  setToken('');
  community.me = null;
}

export async function refreshMe(): Promise<void> {
  try { community.me = token() ? await api.me() : null; } catch { community.me = null; }
}

// --- gallery ---

export const keyName = () => `${NOTE_NAMES[app.project.scaleRoot]} ${SCALES[app.project.scaleType]?.name.toLowerCase() ?? ''}`.trim();

/** Open a published beat in the editor and play it. With `remix`, publishing it later credits the original. */
export async function openBeat(beat: Beat, remix: boolean): Promise<boolean> {
  try {
    const data = await api.beatData(beat.id);
    if (!(await openProjectBytes(data, true))) return false;
    community.origin = { id: beat.id, title: beat.title, author: beat.author };
    if (remix) app.project.name = `${beat.title} remix`.slice(0, 40);
    app.modal = null;
    toast(remix ? `Remixing “${beat.title}” by ${beat.author.displayName}. It's yours to change.` : `“${beat.title}” by ${beat.author.displayName}`);
    void play();
    void api.play(beat.id).catch(() => {});
    return true;
  } catch (e) { fail(e); return false; }
}

export async function publish(meta: { title: string; description: string; tags: string; genre: string }): Promise<Beat | null> {
  try {
    const beat = await api.publish({
      ...meta, bpm: app.project.bpm, key: keyName(), remixOf: community.origin?.id,
    }, projectFileBytes());
    toast(`Published “${beat.title}”`);
    void refreshMe();
    return beat;
  } catch (e) { fail(e); return null; }
}

// --- cloud saves ---

/** Save the beat on screen: a new version of its cloud save, or a new save if it has none. */
export async function saveToCloud(asNew = false): Promise<CloudProject | null> {
  try {
    const name = app.project.name || 'untitled';
    const data = projectFileBytes();
    const saved = community.cloud && !asNew ? await api.saveProject(community.cloud.id, name, data) : await api.createProject(name, data);
    community.cloud = { id: saved.id, name: saved.name, version: saved.version };
    toast(`Saved “${saved.name}” (version ${saved.version})`);
    void refreshMe();
    return saved;
  } catch (e) { fail(e); return null; }
}

/** Open a cloud save, or one of its earlier versions. */
export async function openCloud(project: CloudProject, version?: number): Promise<void> {
  try {
    const data = version === undefined ? await api.projectData(project.id) : await api.versionData(project.id, version);
    if (!(await openProjectBytes(data, true))) return;
    community.cloud = { id: project.id, name: project.name, version: version ?? project.version };
    app.modal = null;
    toast(version === undefined ? `Opened “${project.name}”` : `Opened version ${version} of “${project.name}”. Saving makes it the newest.`);
  } catch (e) { fail(e); }
}

// --- sample packs ---

/** Download a sample from a pack and put it on a track. */
export async function usePackSample(pack: Pack, sample: PackSample, track = app.sel): Promise<void> {
  try {
    const data = await api.sampleData(pack.id, sample.id);
    const file = new File([data as unknown as BlobPart], sample.name, { type: sample.mime });
    if (await importSample(file, track)) toast(`${sample.name} from “${pack.name}” (${pack.license}${pack.attribution ? `, ${pack.attribution}` : ''})`);
  } catch (e) { fail(e); }
}
