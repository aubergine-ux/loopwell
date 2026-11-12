// Builds the HTTP API. Nothing here listens on a port: buildServer() returns
// the Fastify instance, and its `.server` is the plain node:http server, so
// another module can attach an 'upgrade' handler for WebSockets before or
// after listen().

import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Db, Queryable } from './db.ts';
import { RateLimiter } from './ratelimit.ts';
import { authRoutes } from './routes/auth.ts';
import { beatRoutes } from './routes/beats.ts';
import { docsRoutes } from './routes/docs.ts';
import { moderationRoutes } from './routes/moderation.ts';
import { packRoutes } from './routes/packs.ts';
import { projectRoutes } from './routes/projects.ts';
import type { Storage } from './storage.ts';
import { HttpError, forbidden, sha256 } from './util.ts';

export interface User {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: Date;
}

export interface Deps {
  config: Config;
  db: Db;
  storage: Storage;
  /** The clock, replaceable in tests. */
  now?: () => Date;
}

/** What every route module gets. */
export interface Ctx extends Deps {
  now: () => Date;
  limiter: RateLimiter;
  /** Deletes stored objects after their rows are gone; failures only get logged. */
  discard(keys: string[]): Promise<void>;
  /** Bytes of storage a user occupies across saves, beats and samples. */
  usage(q: Queryable, userId: string): Promise<number>;
  /** Takes the per-user upload lock. Call first inside a transaction that adds bytes. */
  lockUser(q: Queryable, userId: string): Promise<void>;
  /** Throws when the user is over quota. Call last inside that transaction. */
  checkQuota(q: Queryable, userId: string): Promise<void>;
  audit(q: Queryable, admin: User, action: string, targetType: string, targetId: string, note?: string): Promise<void>;
  /** Streams a stored object as the response. */
  sendObject(reply: FastifyReply, key: string, opts: { type: string; size: number; disposition: string }): Promise<FastifyReply>;
  /** Drops expired sign-in state, sessions and play records. */
  sweep(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Database, storage and helpers, for modules attached from outside. */
    loopwell: Ctx;
  }
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyContextConfig {
    /** Who may call the route. Absent means anyone. */
    auth?: 'user' | 'admin';
    /** An extra, tighter rate-limit bucket. */
    rate?: 'auth' | 'upload';
  }
}

export interface RouteEntry {
  method: string;
  path: string;
  auth: 'user' | 'admin' | null;
}

const routeLists = new WeakMap<FastifyInstance, RouteEntry[]>();

/** Every route the server registered, with OpenAPI-style `{param}` paths. */
export function routesOf(app: FastifyInstance): RouteEntry[] {
  return routeLists.get(app) ?? [];
}

export function userFromRow(row: Record<string, any>, config: Config): User {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url ?? null,
    isAdmin: !!row.is_admin || config.adminHandles.includes(row.handle),
    createdAt: row.created_at,
  };
}

/** Parses `Authorization: Bearer` and loads the session's user. */
async function authenticate(req: FastifyRequest, ctx: Ctx): Promise<User | null> {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new HttpError(401, 'invalid_token', 'The Authorization header must be "Bearer <token>".');
  const { rows } = await ctx.db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(m[1]), ctx.now()],
  );
  if (!rows.length) throw new HttpError(401, 'invalid_token', 'This session has expired or was signed out. Sign in again.');
  if (rows[0].banned_at) throw new HttpError(403, 'banned', 'This account has been banned.');
  return userFromRow(rows[0], ctx.config);
}

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const { config, db, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const limits = config.limits;

  const app = Fastify({
    logger: config.log && {
      level: 'info',
      // no addresses and no query strings (they can carry OAuth codes) in the logs
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  const routes: RouteEntry[] = [];
  routeLists.set(app, routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, path: route.url.replace(/:(\w+)/g, '{$1}'), auth: route.config?.auth ?? null });
    }
  });

  const ctx: Ctx = {
    config,
    db,
    storage,
    now,
    limiter: new RateLimiter(),
    async discard(keys) {
      if (!keys.length) return;
      try {
        await storage.remove(keys);
      } catch (err) {
        app.log.error({ err, keys: keys.length }, 'could not delete stored objects');
      }
    },
    async usage(q, userId) {
      const { rows } = await q.query(
        `SELECT ((SELECT coalesce(sum(v.size), 0) FROM project_versions v JOIN projects p ON p.id = v.project_id WHERE p.user_id = $1)
               + (SELECT coalesce(sum(size), 0) FROM beats WHERE user_id = $1)
               + (SELECT coalesce(sum(s.size), 0) FROM pack_samples s JOIN packs k ON k.id = s.pack_id WHERE k.user_id = $1))::float8 AS used`,
        [userId],
      );
      return Number(rows[0].used);
    },
    async lockUser(q, userId) {
      // uploads from one user queue up here, so two cannot both slip under the quota
      await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    },
    async checkQuota(q, userId) {
      const used = await ctx.usage(q, userId);
      if (used > limits.userQuotaBytes) {
        const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
        throw new HttpError(413, 'quota_exceeded', `This would put your account at ${mb(used)} MB of its ${mb(limits.userQuotaBytes)} MB storage. Delete something first.`);
      }
    },
    async audit(q, admin, action, targetType, targetId, note = '') {
      await q.query(
        'INSERT INTO audit_log (admin_id, admin_handle, action, target_type, target_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [admin.id, admin.handle, action, targetType, targetId, note, now()],
      );
    },
    async sendObject(reply, key, opts) {
      let stream;
      try {
        stream = await storage.get(key);
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') throw new HttpError(404, 'not_found', 'The stored file is missing.');
        throw err;
      }
      return reply
        .header('content-type', opts.type)
        .header('content-length', opts.size)
        .header('content-disposition', opts.disposition)
        .header('cache-control', 'private, no-cache')
        .send(stream);
    },
    async sweep() {
      const t = now();
      await db.query('DELETE FROM oauth_states WHERE expires_at <= $1', [t]);
      await db.query('DELETE FROM auth_codes WHERE expires_at <= $1', [t]);
      await db.query('DELETE FROM sessions WHERE expires_at <= $1', [t]);
      await db.query('DELETE FROM beat_plays WHERE played_at <= $1', [new Date(t.getTime() - 3_600_000)]);
    },
  };

  await app.register(cors, {
    origin: config.appOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['retry-after'],
    maxAge: 600,
  });

  // uploads arrive as raw bytes; each upload route sets its own size limit
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.decorate('loopwell', ctx);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') return;
    const { auth, rate } = req.routeOptions.config;
    const t = now().getTime();
    const buckets: [string, number][] = [[`all:${req.ip}`, config.rate.perMinute]];
    if (rate === 'auth') buckets.push([`auth:${req.ip}`, config.rate.authPerMinute]);
    if (rate === 'upload') buckets.push([`upload:${req.ip}`, config.rate.uploadsPerMinute]);
    for (const [key, max] of buckets) {
      const hit = ctx.limiter.hit(key, max, 60_000, t);
      if (!hit.ok) {
        reply.header('retry-after', hit.retryAfter);
        throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${hit.retryAfter} seconds.`);
      }
    }
    // runs before the body is read, so anonymous uploads are refused early
    req.user = await authenticate(req, ctx);
    if (auth && !req.user) throw new HttpError(401, 'unauthorized', 'Sign in to do that.');
    if (auth === 'admin' && !req.user!.isAdmin) throw forbidden('Admins only.');
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
    }
    if (status === 413) {
      const max = req.routeOptions.bodyLimit ?? 0;
      const size = max >= 1024 * 1024 ? `${+(max / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(max / 1024)} KB`;
      return reply.code(413).send({ error: { code: 'payload_too_large', message: `The upload is larger than the ${size} this server accepts here.` } });
    }
    const code = status === 415 ? 'unsupported_media_type' : status === 404 ? 'not_found' : 'bad_request';
    return reply.code(status).send({ error: { code, message: err.message } });
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({ error: { code: 'unavailable', message: 'The database is not reachable.' } });
    }
    return { status: 'ok' };
  });

  app.get('/api/config', async () => ({
    providers: Object.keys(config.providers),
    devLogin: config.devLogin,
    limits: {
      projectBytes: limits.projectBytes,
      projectVersions: limits.projectVersions,
      userQuotaBytes: limits.userQuotaBytes,
      sampleBytes: limits.sampleBytes,
      sampleSeconds: limits.sampleSeconds,
      packFiles: limits.packFiles,
      packBytes: limits.packBytes,
    },
  }));

  authRoutes(app, ctx);
  projectRoutes(app, ctx);
  beatRoutes(app, ctx);
  packRoutes(app, ctx);
  moderationRoutes(app, ctx);
  await docsRoutes(app);

  return app;
}

/** The upload body, or a clear error when it is not raw bytes. */
export function uploadBody(req: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the file as the request body with Content-Type: application/octet-stream.');
  }
  return req.body;
}
