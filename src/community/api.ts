// Client for the optional Loopwell server (see server/openapi.yaml). Nothing
// here runs unless a server address has been configured, so the app keeps
// working with no account and no backend.

const SERVER_KEY = 'loopwell:server';
const TOKEN_KEY = 'loopwell:token';

export interface Author { handle: string; displayName: string; avatarUrl: string | null }
export interface User extends Author { id: string; bio: string; isAdmin: boolean; createdAt: string; storage?: { used: number; quota: number } }
export interface ServerConfig {
  providers: ('github' | 'discord')[];
  devLogin: boolean;
  limits: { projectBytes: number; projectVersions: number; userQuotaBytes: number; sampleBytes: number; sampleSeconds: number; packFiles: number; packBytes: number };
}
export interface RemixCredit { id: string; title: string; author: Author }
export interface Beat {
  id: string; title: string; description: string; tags: string[]; genre: string | null; bpm: number | null; key: string | null; size: number;
  author: Author; plays: number; likes: number; likedByMe: boolean; remixCount: number; remixOf: RemixCredit | null; remixRoot: RemixCredit | null;
  hidden: boolean; createdAt: string; updatedAt: string;
}
export interface Profile { handle: string; displayName: string; bio: string; avatarUrl: string | null; joinedAt: string; beatCount: number; totalPlays: number; totalLikes: number; banned?: boolean }
export interface CloudProject { id: string; name: string; version: number; size: number; versionCount: number; createdAt: string; updatedAt: string }
export interface CloudVersion { n: number; size: number; createdAt: string; current: boolean }
export interface PackSample { id: string; name: string; format: string; mime: string; size: number; durationMs: number | null }
export const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'custom'] as const;
export interface Pack {
  id: string; name: string; description: string; license: (typeof LICENSES)[number]; licenseUrl: string; attribution: string; tags: string[];
  author: Author; sampleCount: number; size: number; published: boolean; hidden: boolean; samples?: PackSample[];
}
export const REPORT_REASONS = ['spam', 'abuse', 'copyright', 'explicit', 'other'] as const;
export interface Report {
  id: string; reporter: string; targetType: 'beat' | 'pack' | 'user'; targetId: string;
  target: { exists: boolean; label: string | null; owner: string | null; hidden?: boolean; banned?: boolean };
  reason: string; details: string; status: 'open' | 'resolved'; resolution: string | null; note: string | null; resolvedBy: string | null; createdAt: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const read = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const write = (key: string, v: string) => { try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* private mode */ } };

/** Address of the server this app talks to, or '' for local-only use. Set at build time or by a #server= link. */
export function serverUrl(): string {
  return (read(SERVER_KEY) || (import.meta.env.VITE_LOOPWELL_SERVER as string | undefined) || '').replace(/\/+$/, '');
}

/** Only real web addresses are accepted, and plain http only for a server on this machine. */
export function validServer(url: string): string | null {
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function setServer(url: string): void {
  write(SERVER_KEY, url);
  write(TOKEN_KEY, '');
}

export const token = () => read(TOKEN_KEY);
export const setToken = (t: string) => write(TOKEN_KEY, t);

type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${serverUrl()}/api${path}${s ? `?${s}` : ''}`;
}

async function call(method: string, path: string, opts: { query?: Query; json?: unknown; bytes?: Uint8Array } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token()) headers.Authorization = `Bearer ${token()}`;
  let body: BodyInit | undefined;
  if (opts.bytes) { headers['Content-Type'] = 'application/octet-stream'; body = opts.bytes as unknown as BodyInit; }
  else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  let res: Response;
  try {
    res = await fetch(url(path, opts.query), { method, headers, body });
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection.');
  }
  if (!res.ok) {
    let code = 'error', message = `The server answered ${res.status}.`;
    try { const e = (await res.json()).error; if (e?.message) { code = String(e.code); message = String(e.message); } } catch { /* not JSON */ }
    if (res.status === 401) setToken('');
    throw new ApiError(res.status, code, message);
  }
  return res;
}

const json = async <T>(method: string, path: string, opts?: Parameters<typeof call>[2]): Promise<T> =>
  (res => (res.status === 204 ? (undefined as T) : (res.json() as Promise<T>)))(await call(method, path, opts));
const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await (await call('GET', path)).arrayBuffer());

export const api = {
  config: () => json<ServerConfig>('GET', '/config'),
  startUrl: (provider: string, redirect: string) => url(`/auth/${provider}/start`, { redirect }),
  exchange: (code: string) => json<{ token: string; user: User }>('POST', '/auth/exchange', { json: { code } }),
  devLogin: (handle: string) => json<{ token: string; user: User }>('POST', '/auth/dev-login', { json: { handle } }),
  logout: () => json<void>('POST', '/auth/logout'),
  me: () => json<User>('GET', '/me'),
  updateMe: (patch: { displayName?: string; bio?: string }) => json<User>('PATCH', '/me', { json: patch }),
  deleteMe: () => json<void>('DELETE', '/me'),
  profile: (handle: string) => json<Profile>('GET', `/users/${encodeURIComponent(handle)}`),

  projects: () => json<{ items: CloudProject[] }>('GET', '/projects'),
  createProject: (name: string, data: Uint8Array) => json<CloudProject>('POST', '/projects', { query: { name }, bytes: data }),
  saveProject: (id: string, name: string, data: Uint8Array) => json<CloudProject>('PUT', `/projects/${id}`, { query: { name }, bytes: data }),
  projectData: (id: string) => bytes(`/projects/${id}/data`),
  deleteProject: (id: string) => json<void>('DELETE', `/projects/${id}`),
  versions: (id: string) => json<{ items: CloudVersion[] }>('GET', `/projects/${id}/versions`),
  versionData: (id: string, n: number) => bytes(`/projects/${id}/versions/${n}/data`),
  restore: (id: string, n: number) => json<CloudProject>('POST', `/projects/${id}/versions/${n}/restore`),

  beats: (q: { sort?: string; tag?: string; genre?: string; key?: string; bpmMin?: number; bpmMax?: number; q?: string; user?: string; cursor?: string | null }) =>
    json<Page<Beat>>('GET', '/beats', { query: q }),
  beat: (id: string) => json<Beat>('GET', `/beats/${id}`),
  beatData: (id: string) => bytes(`/beats/${id}/data`),
  remixes: (id: string) => json<Page<Beat>>('GET', `/beats/${id}/remixes`),
  publish: (meta: { title: string; description?: string; tags?: string; genre?: string; bpm?: number; key?: string; remixOf?: string }, data: Uint8Array) =>
    json<Beat>('POST', '/beats', { query: meta, bytes: data }),
  play: (id: string) => json<{ plays: number }>('POST', `/beats/${id}/play`),
  like: (id: string, on: boolean) => json<{ likes: number; likedByMe: boolean }>(on ? 'PUT' : 'DELETE', `/beats/${id}/like`),
  deleteBeat: (id: string) => json<void>('DELETE', `/beats/${id}`),
  tags: () => json<{ items: { tag: string; count: number }[] }>('GET', '/tags'),

  packs: (q: { q?: string; tag?: string; mine?: 1; cursor?: string | null }) => json<Page<Pack>>('GET', '/packs', { query: q }),
  pack: (id: string) => json<Pack>('GET', `/packs/${id}`),
  createPack: (body: { name: string; description?: string; license: string; licenseUrl?: string; attribution?: string; tags?: string[] }) =>
    json<Pack>('POST', '/packs', { json: body }),
  addSample: (pack: string, name: string, data: Uint8Array) => json<PackSample>('POST', `/packs/${pack}/samples`, { query: { name }, bytes: data }),
  removeSample: (pack: string, sid: string) => json<void>('DELETE', `/packs/${pack}/samples/${sid}`),
  publishPack: (id: string) => json<Pack>('POST', `/packs/${id}/publish`),
  sampleData: (pack: string, sid: string) => bytes(`/packs/${pack}/samples/${sid}/data`),
  deletePack: (id: string) => json<void>('DELETE', `/packs/${id}`),

  report: (targetType: string, targetId: string, reason: string, details: string) => json<unknown>('POST', '/reports', { json: { targetType, targetId, reason, details } }),
  reports: (status: 'open' | 'resolved') => json<Page<Report>>('GET', '/admin/reports', { query: { status } }),
  resolve: (id: string, action: string, note: string) => json<Report>('POST', `/admin/reports/${id}/resolve`, { json: { action, note } }),
  unhide: (kind: 'beats' | 'packs', id: string) => json<unknown>('POST', `/admin/${kind}/${id}/unhide`),
  unban: (handle: string) => json<unknown>('POST', `/admin/users/${encodeURIComponent(handle)}/unban`),
  audit: () => json<Page<{ id: string; admin: string; action: string; targetType: string; targetId: string; note: string | null; createdAt: string }>>('GET', '/admin/audit'),
};
