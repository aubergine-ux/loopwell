// Sign-in and the account itself. The app lives on another origin, so there
// are no cookies: OAuth ends with a one-time code in the URL fragment, which
// the app swaps for a bearer token.

import type { FastifyInstance } from 'fastify';
import { PROVIDERS, type ProviderConfig, type ProviderName } from '../config.ts';
import type { Queryable } from '../db.ts';
import { userFromRow, type Ctx, type User } from '../server.ts';
import { HttpError, bag, badRequest, newId, notFound, optStr, randomToken, sha256, slug, str, type Bag } from '../util.ts';

const STATE_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;

interface Profile {
  id: string;
  login: string;
  name: string;
  avatarUrl: string | null;
}

/** Maps each provider's "who am I" response onto the few fields we keep. */
function readProfile(provider: ProviderName, raw: Bag): Profile {
  const id = raw.id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error('provider profile has no id');
  if (provider === 'github') {
    const login = String(raw.login ?? '');
    return { id: String(id), login, name: typeof raw.name === 'string' && raw.name ? raw.name : login, avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : null };
  }
  const login = String(raw.username ?? '');
  return {
    id: String(id),
    login,
    name: typeof raw.global_name === 'string' && raw.global_name ? raw.global_name : login,
    avatarUrl: typeof raw.avatar === 'string' && raw.avatar ? `https://cdn.discordapp.com/avatars/${id}/${raw.avatar}.png` : null,
  };
}

async function fetchProfile(provider: ProviderName, p: ProviderConfig, code: string, redirectUri: string): Promise<Profile> {
  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: p.clientId, client_secret: p.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as Bag;
  if (!tokenRes.ok || typeof token.access_token !== 'string') throw new Error(`token exchange failed with status ${tokenRes.status}`);
  const userRes = await fetch(p.userUrl, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'user-agent': 'loopwell-server' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new Error(`profile request failed with status ${userRes.status}`);
  return readProfile(provider, (await userRes.json()) as Bag);
}

export function publicUser(u: User) {
  return { id: u.id, handle: u.handle, displayName: u.displayName, bio: u.bio, avatarUrl: u.avatarUrl, isAdmin: u.isAdmin, createdAt: u.createdAt };
}

export function authRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { config, db, now } = ctx;

  function providerFor(name: string): { name: ProviderName; cfg: ProviderConfig } {
    const cfg = PROVIDERS.includes(name as ProviderName) ? config.providers[name as ProviderName] : undefined;
    if (!cfg) throw new HttpError(404, 'provider_disabled', `Sign-in with "${name}" is not enabled on this server.`);
    return { name: name as ProviderName, cfg };
  }

  const callbackUrl = (provider: string) => `${config.publicUrl}/api/auth/${provider}/callback`;

  /** Where to send the browser afterwards; must be on an allowed app origin. */
  function appRedirect(raw: unknown): string {
    if (raw === undefined || raw === '') return `${config.appOrigins[0]}/`;
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      throw badRequest('"redirect" must be an absolute URL.', 'invalid_redirect');
    }
    if (!config.appOrigins.includes(url.origin)) throw badRequest('"redirect" is not on an origin this server allows.', 'invalid_redirect');
    url.hash = '';
    return url.toString();
  }

  /** Finds the account behind a provider identity, creating it on first sign-in. */
  async function upsertUser(provider: string, profile: Profile): Promise<Record<string, any>> {
    return db.tx(async (q) => {
      const found = await q.query(
        'SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_user_id = $2',
        [provider, profile.id],
      );
      if (found.rows.length) {
        const u = found.rows[0];
        // the avatar follows the provider; the name stays whatever the user set here
        if (profile.avatarUrl !== u.avatar_url) await q.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [u.id, profile.avatarUrl]);
        return { ...u, avatar_url: profile.avatarUrl };
      }
      const handle = await freeHandle(q, profile.login);
      const id = newId();
      const created = await q.query(
        'INSERT INTO users (id, handle, display_name, avatar_url, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [id, handle, (profile.name || handle).slice(0, 60), profile.avatarUrl, now()],
      );
      await q.query('INSERT INTO identities (provider, provider_user_id, user_id) VALUES ($1, $2, $3)', [provider, profile.id, id]);
      return created.rows[0];
    });
  }

  /** The provider login as a handle, with a suffix when someone already has it. */
  async function freeHandle(q: Queryable, login: string): Promise<string> {
    const base = slug(login, 28) || 'user';
    for (let n = 1; n < 50; n++) {
      const handle = n === 1 ? base : `${base}-${n}`;
      const taken = await q.query('SELECT 1 FROM users WHERE handle = $1', [handle]);
      if (!taken.rows.length) return handle;
    }
    return `${base}-${newId().slice(0, 6)}`;
  }

  async function openSession(userId: string): Promise<string> {
    const token = randomToken();
    const t = now();
    await db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token), userId, t, new Date(t.getTime() + config.sessionTtlDays * 86_400_000),
    ]);
    return token;
  }

  app.get('/api/auth/:provider/start', { config: { rate: 'auth' } }, async (req, reply) => {
    const { name, cfg } = providerFor((req.params as { provider: string }).provider);
    const redirect = appRedirect((req.query as Bag).redirect);
    const state = randomToken();
    await db.query('INSERT INTO oauth_states (state_hash, provider, redirect, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(state), name, redirect, new Date(now().getTime() + STATE_TTL_MS),
    ]);
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(name));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scope);
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/:provider/callback', { config: { rate: 'auth' } }, async (req, reply) => {
    const { name, cfg } = providerFor((req.params as { provider: string }).provider);
    const query = req.query as Bag;
    const state = typeof query.state === 'string' ? query.state : '';
    // a state is good for one round trip only
    const found = await db.query(
      'DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 AND expires_at > $3 RETURNING redirect',
      [sha256(state), name, now()],
    );
    if (!found.rows.length) throw badRequest('This sign-in link has expired or was already used. Start again from the app.', 'invalid_state');
    const redirect: string = found.rows[0].redirect;
    const back = (fragment: string) => reply.redirect(`${redirect}#${fragment}`);

    if (typeof query.code !== 'string' || !query.code) {
      const reason = typeof query.error === 'string' && /^[a-z_]{1,40}$/.test(query.error) ? query.error : 'provider_error';
      return back(`auth_error=${reason}`);
    }
    let profile: Profile;
    try {
      profile = await fetchProfile(name, cfg, query.code, callbackUrl(name));
    } catch (err) {
      req.log.warn({ err, provider: name }, 'sign-in failed at the provider');
      return back('auth_error=provider_error');
    }
    const user = await upsertUser(name, profile);
    if (user.banned_at) return back('auth_error=banned');

    const code = randomToken();
    await db.query('INSERT INTO auth_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      sha256(code), user.id, new Date(now().getTime() + CODE_TTL_MS),
    ]);
    return back(`auth=${code}`);
  });

  app.post('/api/auth/exchange', { config: { rate: 'auth' } }, async (req) => {
    const code = str(bag(req.body), 'code', { max: 200, min: 1 });
    const found = await db.query(
      `DELETE FROM auth_codes c USING users u
        WHERE c.code_hash = $1 AND c.expires_at > $2 AND u.id = c.user_id
        RETURNING u.*`,
      [sha256(code), now()],
    );
    if (!found.rows.length) throw badRequest('This sign-in code has expired or was already used.', 'invalid_code');
    if (found.rows[0].banned_at) throw new HttpError(403, 'banned', 'This account has been banned.');
    const token = await openSession(found.rows[0].id);
    return { token, user: publicUser(userFromRow(found.rows[0], config)) };
  });

  if (config.devLogin) {
    // Tokens without OAuth, for local development and smoke tests. Only
    // registered with DEV_LOGIN=1 outside production.
    app.post('/api/auth/dev-login', { config: { rate: 'auth' } }, async (req) => {
      const body = bag(req.body);
      const handle = slug(str(body, 'handle', { max: 28, min: 1, line: true }), 28);
      if (!handle) throw badRequest('"handle" needs at least one letter or digit.');
      const name = optStr(body, 'displayName', { max: 60, line: true }) || handle;
      const user = await upsertUser('dev', { id: handle, login: handle, name, avatarUrl: null });
      if (user.banned_at) throw new HttpError(403, 'banned', 'This account has been banned.');
      const token = await openSession(user.id);
      return { token, user: publicUser(userFromRow(user, config)) };
    });
  }

  app.post('/api/auth/logout', { config: { auth: 'user' } }, async (req, reply) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')![1];
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    return reply.code(204).send();
  });

  const me = async (user: User) => ({
    ...publicUser(user),
    storage: { used: await ctx.usage(db, user.id), quota: config.limits.userQuotaBytes },
  });

  app.get('/api/me', { config: { auth: 'user' } }, async (req) => me(req.user!));

  app.patch('/api/me', { config: { auth: 'user' } }, async (req) => {
    const body = bag(req.body);
    const displayName = optStr(body, 'displayName', { max: 60, min: 1, line: true });
    const bio = optStr(body, 'bio', { max: 500 });
    const { rows } = await db.query(
      'UPDATE users SET display_name = coalesce($2, display_name), bio = coalesce($3, bio) WHERE id = $1 RETURNING *',
      [req.user!.id, displayName ?? null, bio ?? null],
    );
    return me(userFromRow(rows[0], config));
  });

  app.delete('/api/me', { config: { auth: 'user' } }, async (req, reply) => {
    const id = req.user!.id;
    const keys = await db.tx(async (q) => {
      await ctx.lockUser(q, id);
      const stored = await q.query(
        `SELECT v.storage_key FROM project_versions v JOIN projects p ON p.id = v.project_id WHERE p.user_id = $1
         UNION ALL SELECT storage_key FROM beats WHERE user_id = $1
         UNION ALL SELECT s.storage_key FROM pack_samples s JOIN packs k ON k.id = s.pack_id WHERE k.user_id = $1`,
        [id],
      );
      // likes this user gave vanish with the account, so the counters follow
      await q.query('UPDATE beats SET likes = likes - 1 WHERE id IN (SELECT beat_id FROM beat_likes WHERE user_id = $1)', [id]);
      await q.query('DELETE FROM users WHERE id = $1', [id]);
      return stored.rows.map((r) => r.storage_key as string);
    });
    await ctx.discard(keys);
    return reply.code(204).send();
  });

  app.get('/api/users/:handle', async (req) => {
    const handle = (req.params as { handle: string }).handle.toLowerCase();
    const { rows } = await db.query(
      `SELECT u.*,
              (SELECT count(*) FROM beats b WHERE b.user_id = u.id AND b.hidden_at IS NULL)::int AS beat_count,
              (SELECT coalesce(sum(b.plays), 0) FROM beats b WHERE b.user_id = u.id AND b.hidden_at IS NULL)::int AS total_plays,
              (SELECT coalesce(sum(b.likes), 0) FROM beats b WHERE b.user_id = u.id AND b.hidden_at IS NULL)::int AS total_likes
         FROM users u WHERE u.handle = $1`,
      [handle],
    );
    const row = rows[0];
    // a banned profile stays visible to admins only
    if (!row || (row.banned_at && !req.user?.isAdmin)) throw notFound('User');
    return {
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url ?? null,
      joinedAt: row.created_at,
      beatCount: row.beat_count,
      totalPlays: row.total_plays,
      totalLikes: row.total_likes,
      ...(req.user?.isAdmin ? { banned: !!row.banned_at } : {}),
    };
  });
}
