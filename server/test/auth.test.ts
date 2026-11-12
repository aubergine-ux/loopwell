import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { API_URL, APP_ORIGIN, fakeProvider, rig, zip, type FakeProvider, type Rig } from './helpers.ts';

let fake: FakeProvider;
let r: Rig;

beforeAll(async () => {
  fake = await fakeProvider();
  r = await rig({
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'fake-secret',
    GITHUB_AUTHORIZE_URL: `${fake.url}/authorize`,
    GITHUB_TOKEN_URL: `${fake.url}/token`,
    GITHUB_USER_URL: `${fake.url}/user`,
    DISCORD_CLIENT_ID: 'dc-client',
    DISCORD_CLIENT_SECRET: 'fake-secret',
    DISCORD_AUTHORIZE_URL: `${fake.url}/authorize`,
    DISCORD_TOKEN_URL: `${fake.url}/token`,
    DISCORD_USER_URL: `${fake.url}/user`,
  });
});

afterAll(async () => {
  await r.close();
  await fake.close();
});

/** Walks the browser's side of the flow and returns where the app ends up. */
async function signIn(provider: string, redirect = `${APP_ORIGIN}/studio?x=1`): Promise<URL> {
  const start = await r.call('GET', `/api/auth/${provider}/start?redirect=${encodeURIComponent(redirect)}`);
  expect(start.status).toBe(302);
  const atProvider = await fetch(start.headers.location, { redirect: 'manual' });
  expect(atProvider.status).toBe(302);
  const callback = new URL(atProvider.headers.get('location')!);
  expect(callback.origin).toBe(API_URL);
  const done = await r.call('GET', callback.pathname + callback.search);
  expect(done.status).toBe(302);
  return new URL(done.headers.location);
}

const fragment = (url: URL) => new URLSearchParams(url.hash.slice(1));

describe('OAuth sign-in', () => {
  it('runs the whole GitHub flow and ends with a working token', async () => {
    fake.profile = { id: 4242, login: 'Mona-Lisa', name: 'Mona Lisa', avatar_url: 'https://avatars.test/mona.png' };
    const landed = await signIn('github');
    expect(landed.origin + landed.pathname + landed.search).toBe(`${APP_ORIGIN}/studio?x=1`);
    const code = fragment(landed).get('auth')!;
    expect(code).toBeTruthy();
    expect(fake.tokenRequests.at(-1)).toMatchObject({ client_id: 'gh-client', grant_type: 'authorization_code', redirect_uri: `${API_URL}/api/auth/github/callback` });

    const exchanged = await r.call('POST', '/api/auth/exchange', { json: { code } });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.user).toMatchObject({ handle: 'mona-lisa', displayName: 'Mona Lisa', avatarUrl: 'https://avatars.test/mona.png', isAdmin: false });

    const me = await r.call('GET', '/api/me', { token: exchanged.body.token });
    expect(me.status).toBe(200);
    expect(me.body.handle).toBe('mona-lisa');
    expect(me.body.storage).toEqual({ used: 0, quota: r.config.limits.userQuotaBytes });

    // the code is single use
    const again = await r.call('POST', '/api/auth/exchange', { json: { code } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invalid_code');
  });

  it('stores only hashes of tokens, codes and states', async () => {
    fake.profile = { id: 4242, login: 'Mona-Lisa' };
    const code = fragment(await signIn('github')).get('auth')!;
    const pending = await r.db.query('SELECT code_hash FROM auth_codes');
    expect(pending.rows.map((x) => x.code_hash)).not.toContain(code);
    const { body } = await r.call('POST', '/api/auth/exchange', { json: { code } });
    const sessions = await r.db.query('SELECT token_hash FROM sessions');
    expect(sessions.rows.length).toBeGreaterThan(0);
    for (const s of sessions.rows) {
      expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.token_hash).not.toBe(body.token);
    }
  });

  it('signs the same provider account into the same user, keeping local edits', async () => {
    fake.profile = { id: 4242, login: 'Mona-Lisa', name: 'Renamed Upstream', avatar_url: 'https://avatars.test/new.png' };
    const before = await r.db.query('SELECT count(*)::int AS n FROM users');
    const { body } = await r.call('POST', '/api/auth/exchange', { json: { code: fragment(await signIn('github')).get('auth') } });
    const after = await r.db.query('SELECT count(*)::int AS n FROM users');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(body.user.displayName).toBe('Mona Lisa');
    expect(body.user.avatarUrl).toBe('https://avatars.test/new.png');
  });

  it('runs the Discord flow and gives a clashing login a distinct handle', async () => {
    fake.profile = { id: '99887766', username: 'mona-lisa', global_name: 'Mona D', avatar: 'abc123' };
    const { body } = await r.call('POST', '/api/auth/exchange', { json: { code: fragment(await signIn('discord')).get('auth') } });
    expect(body.user).toMatchObject({ handle: 'mona-lisa-2', displayName: 'Mona D', avatarUrl: 'https://cdn.discordapp.com/avatars/99887766/abc123.png' });
    expect(fake.tokenRequests.at(-1)).toMatchObject({ client_id: 'dc-client', redirect_uri: `${API_URL}/api/auth/discord/callback` });
  });

  it('refuses redirects outside APP_ORIGINS', async () => {
    for (const bad of ['https://evil.test/', 'not a url', `${APP_ORIGIN}.evil.test/`]) {
      const res = await r.call('GET', `/api/auth/github/start?redirect=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_redirect');
    }
  });

  it('rejects a callback with an unknown or replayed state', async () => {
    const forged = await r.call('GET', '/api/auth/github/callback?code=code-1&state=made-up');
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('invalid_state');

    fake.profile = { id: 4242, login: 'Mona-Lisa' };
    const start = await r.call('GET', `/api/auth/github/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`);
    const callback = new URL((await fetch(start.headers.location, { redirect: 'manual' })).headers.get('location')!);
    expect((await r.call('GET', callback.pathname + callback.search)).status).toBe(302);
    const replay = await r.call('GET', callback.pathname + callback.search);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('invalid_state');
  });

  it('expires states and one-time codes', async () => {
    fake.profile = { id: 4242, login: 'Mona-Lisa' };
    const start = await r.call('GET', `/api/auth/github/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`);
    const callback = new URL((await fetch(start.headers.location, { redirect: 'manual' })).headers.get('location')!);
    r.clock.advance(11 * 60_000);
    expect((await r.call('GET', callback.pathname + callback.search)).status).toBe(400);

    const code = fragment(await signIn('github')).get('auth')!;
    r.clock.advance(61_000);
    const late = await r.call('POST', '/api/auth/exchange', { json: { code } });
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('invalid_code');
  });

  it('sends provider refusals and failures back to the app as auth_error', async () => {
    fake.deny = true;
    expect(fragment(await signIn('github')).get('auth_error')).toBe('access_denied');
    fake.deny = false;

    // a code the provider does not know: the token exchange fails
    const start = await r.call('GET', `/api/auth/github/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`);
    const state = new URL(start.headers.location).searchParams.get('state');
    const res = await r.call('GET', `/api/auth/github/callback?code=bogus&state=${state}`);
    expect(res.status).toBe(302);
    expect(fragment(new URL(res.headers.location)).get('auth_error')).toBe('provider_error');
  });

  it('404s for a provider that is not configured', async () => {
    const bare = await rig();
    try {
      const res = await bare.call('GET', `/api/auth/github/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('provider_disabled');
      expect((await bare.call('GET', '/api/auth/gitlab/start')).status).toBe(404);
      expect((await bare.call('GET', '/api/config')).body.providers).toEqual([]);
    } finally {
      await bare.close();
    }
  });
});

describe('tokens and the account', () => {
  it('requires a valid bearer token', async () => {
    expect((await r.call('GET', '/api/me')).status).toBe(401);
    const bad = await r.call('GET', '/api/me', { token: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: { code: 'invalid_token', message: expect.any(String) } });
    const malformed = await r.call('GET', '/api/me', { headers: { authorization: 'Basic abc' } });
    expect(malformed.status).toBe(401);
  });

  it('logs out one session without touching the others', async () => {
    const a = await r.login('twosessions');
    const b = await r.login('twosessions');
    expect((await r.call('POST', '/api/auth/logout', { token: a })).status).toBe(204);
    expect((await r.call('GET', '/api/me', { token: a })).status).toBe(401);
    expect((await r.call('GET', '/api/me', { token: b })).status).toBe(200);
  });

  it('expires sessions', async () => {
    const token = await r.login('sleepy');
    r.clock.advance(31 * 86_400_000);
    expect((await r.call('GET', '/api/me', { token })).status).toBe(401);
    await r.app.loopwell.sweep();
    const left = await r.db.query("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.handle = 'sleepy'");
    expect(left.rows.length).toBe(0);
  });

  it('updates the profile and validates it', async () => {
    const token = await r.login('editor');
    const ok = await r.call('PATCH', '/api/me', { token, json: { displayName: '  Ed   Itor ', bio: 'I make\nloops.' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: 'Ed Itor', bio: 'I make\nloops.' });
    const partial = await r.call('PATCH', '/api/me', { token, json: { bio: '' } });
    expect(partial.body).toMatchObject({ displayName: 'Ed Itor', bio: '' });

    for (const json of [{ displayName: '' }, { displayName: 'x'.repeat(61) }, { bio: 'x'.repeat(501) }, { bio: 5 }, []]) {
      const res = await r.call('PATCH', '/api/me', { token, json });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_input');
    }

    const profile = await r.call('GET', '/api/users/EDITOR');
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ handle: 'editor', displayName: 'Ed Itor', beatCount: 0, totalPlays: 0, totalLikes: 0 });
    expect(profile.body).not.toHaveProperty('id');
    expect((await r.call('GET', '/api/users/nobody-here')).status).toBe(404);
  });

  it('deletes the account with everything it owns', async () => {
    const token = await r.login('leaver');
    const other = await r.login('stayer');
    const project = await r.call('POST', '/api/projects?name=Gone', { token, bytes: zip(100) });
    await r.call('PUT', `/api/projects/${project.body.id}`, { token, bytes: zip(120) });
    const beat = await r.call('POST', '/api/beats?title=Gone%20beat', { token, bytes: zip(90) });
    const theirs = await r.call('POST', '/api/beats?title=Stays', { token: other, bytes: zip(80) });
    await r.call('PUT', `/api/beats/${theirs.body.id}/like`, { token });
    const remix = await r.call('POST', `/api/beats?title=Remix&remixOf=${beat.body.id}`, { token: other, bytes: zip(70) });
    expect(remix.body.remixOf.id).toBe(beat.body.id);
    expect((await r.stored()).length).toBe(5);

    expect((await r.call('DELETE', '/api/me', { token })).status).toBe(204);
    expect((await r.call('GET', '/api/me', { token })).status).toBe(401);
    expect((await r.call('GET', '/api/users/leaver')).status).toBe(404);
    expect((await r.call('GET', `/api/beats/${beat.body.id}`)).status).toBe(404);
    // only the other user's two files are left, their like count is corrected, the remix lost its parent
    expect((await r.stored()).sort()).toEqual([`beats/${remix.body.id}`, `beats/${theirs.body.id}`].sort());
    expect((await r.call('GET', `/api/beats/${theirs.body.id}`)).body.likes).toBe(0);
    expect((await r.call('GET', `/api/beats/${remix.body.id}`)).body.remixOf).toBeNull();
    const rows = await r.db.query("SELECT 1 FROM projects p JOIN users u ON u.id = p.user_id WHERE u.handle = 'leaver'");
    expect(rows.rows.length).toBe(0);
  });
});

describe('cross-cutting', () => {
  it('reports health, config and a JSON 404', async () => {
    expect((await r.call('GET', '/api/health')).body).toEqual({ status: 'ok' });
    const cfg = await r.call('GET', '/api/config');
    expect(cfg.body.providers).toEqual(['github', 'discord']);
    expect(cfg.body.limits).toMatchObject({ projectBytes: 30 * 1024 * 1024, projectVersions: 50, sampleBytes: 10 * 1024 * 1024, sampleSeconds: 60, packFiles: 64 });
    const missing = await r.call('GET', '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('answers CORS for allowed origins only', async () => {
    const ok = await r.call('GET', '/api/health', { headers: { origin: APP_ORIGIN } });
    expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    const other = await r.call('GET', '/api/health', { headers: { origin: 'https://evil.test' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await r.call('OPTIONS', '/api/projects', {
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
    // errors carry the header too, so the app can read them
    const denied = await r.call('GET', '/api/me', { headers: { origin: APP_ORIGIN } });
    expect(denied.status).toBe(401);
    expect(denied.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('rejects malformed and oversized JSON with the standard error shape', async () => {
    const token = await r.login('jsonuser');
    const broken = await r.app.inject({ method: 'PATCH', url: '/api/me', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: '{nope' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('bad_request');
    const huge = await r.call('PATCH', '/api/me', { token, json: { bio: 'x'.repeat(300 * 1024) } });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('payload_too_large');
  });

  it('rate limits per address', async () => {
    const tight = await rig({ RATE_LIMIT_PER_MINUTE: '5', RATE_LIMIT_AUTH_PER_MINUTE: '2' });
    try {
      for (let i = 0; i < 5; i++) expect((await tight.call('GET', '/api/health', { ip: '10.9.9.9' })).status).toBe(200);
      const limited = await tight.call('GET', '/api/health', { ip: '10.9.9.9' });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // another address is unaffected, and the window resets
      expect((await tight.call('GET', '/api/health', { ip: '10.9.9.8' })).status).toBe(200);
      tight.clock.advance(61_000);
      expect((await tight.call('GET', '/api/health', { ip: '10.9.9.9' })).status).toBe(200);

      // sign-in routes have their own tighter bucket
      const login = () => tight.call('POST', '/api/auth/dev-login', { json: { handle: 'a' }, ip: '10.7.7.7' });
      expect((await login()).status).toBe(200);
      expect((await login()).status).toBe(200);
      expect((await login()).status).toBe(429);
    } finally {
      await tight.close();
    }
  });

  it('leaves the http server open for a WebSocket upgrade handler', async () => {
    const extra = await rig();
    try {
      // what a realtime module would do: claim upgrades on the underlying server
      extra.app.server.on('upgrade', (req, socket) => {
        socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${req.url}\r\n\r\n`);
      });
      await extra.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = extra.app.server.address() as { port: number };
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('GET /api/realtime HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        let data = '';
        socket.on('data', (c) => (data += c));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(reply).toContain('101 Switching Protocols');
      expect(reply).toContain('X-Path: /api/realtime');
      // ordinary requests still go to the API
      expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toEqual({ status: 'ok' });
    } finally {
      await extra.close();
    }
  });

  it('keeps the dev login off unless asked, and always off in production', async () => {
    expect(loadConfig({}).devLogin).toBe(false);
    expect(loadConfig({ DEV_LOGIN: '1' }).devLogin).toBe(true);
    expect(loadConfig({ DEV_LOGIN: '1', NODE_ENV: 'production' }).devLogin).toBe(false);
    const prod = await rig({ NODE_ENV: 'production' });
    try {
      expect((await prod.call('POST', '/api/auth/dev-login', { json: { handle: 'a' } })).status).toBe(404);
      expect((await prod.call('GET', '/api/config')).body.devLogin).toBe(false);
    } finally {
      await prod.close();
    }
  });

  it('reads and validates the environment', () => {
    const cfg = loadConfig({ APP_ORIGINS: 'https://a.test/path, http://localhost:5173', MAX_PROJECT_MB: '5', ADMIN_HANDLES: 'Ann, bob', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://minio:9000' });
    expect(cfg.appOrigins).toEqual(['https://a.test', 'http://localhost:5173']);
    expect(cfg.limits.projectBytes).toBe(5 * 1024 * 1024);
    expect(cfg.adminHandles).toEqual(['ann', 'bob']);
    expect(cfg.port).toBe(8787);
    expect(cfg.storage).toMatchObject({ driver: 's3', bucket: 'b', forcePathStyle: true });
    expect(cfg.providers).toEqual({});
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ APP_ORIGINS: 'nope' })).toThrow(/APP_ORIGINS/);
    expect(() => loadConfig({ S3_BUCKET: 'b' })).toThrow(/S3_ACCESS_KEY_ID/);
  });
});
