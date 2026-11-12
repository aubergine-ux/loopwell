// Sample packs: a licensed set of audio files. A pack starts as a draft only
// its owner can see, takes samples one upload at a time, and is listed once
// published. Every sample is scanned before it is stored (see audio.ts).

import type { FastifyInstance } from 'fastify';
import { AUDIO_MIME, scanAudio, type AudioFormat } from '../audio.ts';
import type { Queryable } from '../db.ts';
import { uploadBody, type Ctx, type User } from '../server.ts';
import {
  HttpError, attachment, badRequest, bag, decodeCursor, encodeCursor, forbidden, httpUrl, likePattern, newId, notFound,
  oneOf, optStr, pageLimit, slug, str, tags, type Bag,
} from '../util.ts';

export const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'custom'] as const;

const LICENSE_URLS: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
};

// $1 is the viewer's id ('' when signed out), $2 whether they are an admin
const PUBLIC = '(k.published_at IS NOT NULL AND k.hidden_at IS NULL AND u.banned_at IS NULL)';
const VISIBLE = `(${PUBLIC} OR k.user_id = $1 OR $2::boolean)`;
// drafts sort by when they were made, published packs by when they went public
const SORT_AT = 'coalesce(k.published_at, k.created_at)';

const SELECT = `
  SELECT k.*, ${SORT_AT} AS sort_at, u.handle, u.display_name, u.avatar_url,
         (SELECT count(*) FROM pack_samples s WHERE s.pack_id = k.id)::int AS sample_count,
         (SELECT coalesce(sum(s.size), 0) FROM pack_samples s WHERE s.pack_id = k.id)::float8 AS total_size
    FROM packs k JOIN users u ON u.id = k.user_id`;

function sampleJson(r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    format: r.format,
    mime: AUDIO_MIME[r.format as AudioFormat],
    size: Number(r.size),
    durationMs: r.duration_ms,
    channels: r.channels,
    sampleRate: r.sample_rate,
    createdAt: r.created_at,
  };
}

function packJson(r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    license: r.license,
    licenseUrl: r.license_url,
    attribution: r.attribution,
    tags: r.tags,
    author: { handle: r.handle, displayName: r.display_name, avatarUrl: r.avatar_url ?? null },
    sampleCount: r.sample_count,
    size: Number(r.total_size),
    published: !!r.published_at,
    publishedAt: r.published_at,
    hidden: !!r.hidden_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Deletes a pack's rows and returns the storage keys to discard afterwards. */
export async function removePack(q: Queryable, id: string): Promise<string[]> {
  const stored = await q.query('SELECT storage_key FROM pack_samples WHERE pack_id = $1', [id]);
  await q.query('DELETE FROM packs WHERE id = $1', [id]);
  return stored.rows.map((r) => r.storage_key);
}

export function packRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, storage, now } = ctx;
  const limits = ctx.config.limits;
  const signedIn = { config: { auth: 'user' } } as const;

  const viewer = (user: User | null): [string, boolean] => [user?.id ?? '', !!user?.isAdmin];

  async function find(q: Queryable, id: string, user: User | null): Promise<Record<string, any>> {
    const { rows } = await q.query(`${SELECT} WHERE k.id = $3 AND ${VISIBLE}`, [...viewer(user), id]);
    if (!rows.length) throw notFound('Pack');
    return rows[0];
  }

  /** A pack the caller owns. Admins moderate packs but do not edit them. */
  async function findOwn(q: Queryable, id: string, user: User): Promise<Record<string, any>> {
    const pack = await find(q, id, user);
    if (pack.user_id !== user.id) throw forbidden('Only the owner can change this pack.');
    return pack;
  }

  const samplesOf = async (packId: string) =>
    (await db.query('SELECT * FROM pack_samples WHERE pack_id = $1 ORDER BY created_at, id', [packId])).rows.map(sampleJson);

  app.post('/api/packs', signedIn, async (req, reply) => {
    const body = bag(req.body);
    const user = req.user!;
    const license = oneOf(body, 'license', LICENSES);
    const licenseUrl = license === 'custom' ? httpUrl(body, 'licenseUrl') : LICENSE_URLS[license];
    if (!licenseUrl) throw badRequest('"licenseUrl" is required when the license is "custom".');
    const id = newId();
    const t = now();
    await db.query(
      `INSERT INTO packs (id, user_id, name, description, license, license_url, attribution, tags, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $9)`,
      [id, user.id, str(body, 'name', { max: 80, min: 1, line: true }), optStr(body, 'description', { max: 2000 }) ?? '', license, licenseUrl,
        // credit defaults to the uploader, which is what the BY licenses need
        optStr(body, 'attribution', { max: 200, line: true }) || user.displayName, tags(body.tags), t],
    );
    return reply.code(201).send({ ...packJson(await find(db, id, user)), samples: [] });
  });

  app.get('/api/packs', async (req) => {
    const query = req.query as Bag;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    // drafts only ever show up under mine=1; a hidden pack stays listed for its owner and admins
    if (['1', 'true'].includes(String(query.mine ?? ''))) {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Sign in to list your own packs.');
      add('k.user_id = ?', req.user.id);
    } else {
      params.push(...viewer(req.user));
      where.push(`(${PUBLIC} OR (k.published_at IS NOT NULL AND (k.user_id = $1 OR $2::boolean)))`);
    }
    const tag = slug(optStr(query, 'tag', { max: 60 }) ?? '', 24);
    if (tag) add('? = ANY (k.tags)', tag);
    const user = optStr(query, 'user', { max: 60 });
    if (user) add('u.handle = ?', user.toLowerCase());
    const q = optStr(query, 'q', { max: 100, line: true });
    if (q) add('(k.name ILIKE ? OR k.description ILIKE ?)', likePattern(q));
    const cursor = optStr(query, 'cursor', { max: 300 });
    if (cursor) {
      const [at, id] = decodeCursor(cursor, ['string', 'string']);
      params.push(at, id);
      where.push(`(${SORT_AT}, k.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    const limit = pageLimit(query);
    params.push(limit + 1);
    const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORT_AT} DESC, k.id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(packJson),
      nextCursor: rows.length > limit ? encodeCursor([(last.sort_at as Date).toISOString(), last.id]) : null,
    };
  });

  app.get('/api/packs/:id', async (req) => {
    const pack = await find(db, (req.params as { id: string }).id, req.user);
    return { ...packJson(pack), samples: await samplesOf(pack.id) };
  });

  app.post('/api/packs/:id/samples', { config: { auth: 'user', rate: 'upload' }, bodyLimit: limits.sampleBytes }, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const data = uploadBody(req);
    // keep the last path segment only, in case a full path was sent
    const rawName = str(req.query as Bag, 'name', { max: 300, min: 1, line: true }).split(/[\\/]/).pop()!.trim();
    if (!rawName || rawName.length > 80) throw badRequest('"name" must be a file name of 1 to 80 characters.');
    await findOwn(db, id, user);
    const info = scanAudio(data, limits.sampleSeconds);

    const sid = newId();
    const key = `packs/${id}/${sid}`;
    await storage.put(key, data);
    try {
      const row = await db.tx(async (q) => {
        await ctx.lockUser(q, user.id);
        const pack = await findOwn(q, id, user);
        if (pack.sample_count >= limits.packFiles) {
          throw new HttpError(409, 'pack_full', `A pack can hold at most ${limits.packFiles} samples.`);
        }
        if (Number(pack.total_size) + data.length > limits.packBytes) {
          throw new HttpError(413, 'pack_too_large', `A pack can hold at most ${+(limits.packBytes / 1024 / 1024).toFixed(1)} MB of samples.`);
        }
        const t = now();
        const inserted = await q.query(
          `INSERT INTO pack_samples (id, pack_id, name, format, size, duration_ms, channels, sample_rate, storage_key, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [sid, id, rawName, info.format, data.length, info.durationMs, info.channels, info.sampleRate, key, t],
        );
        await q.query('UPDATE packs SET updated_at = $2 WHERE id = $1', [id, t]);
        await ctx.checkQuota(q, user.id);
        return inserted.rows[0];
      });
      return reply.code(201).send(sampleJson(row));
    } catch (err) {
      await ctx.discard([key]);
      throw err;
    }
  });

  app.delete('/api/packs/:id/samples/:sid', signedIn, async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    await findOwn(db, id, req.user!);
    const { rows } = await db.query('DELETE FROM pack_samples WHERE id = $1 AND pack_id = $2 RETURNING storage_key', [sid, id]);
    if (!rows.length) throw notFound('Sample');
    await db.query('UPDATE packs SET updated_at = $2 WHERE id = $1', [id, now()]);
    await ctx.discard([rows[0].storage_key]);
    return reply.code(204).send();
  });

  app.post('/api/packs/:id/publish', signedIn, async (req) => {
    const user = req.user!;
    const pack = await findOwn(db, (req.params as { id: string }).id, user);
    if (!pack.sample_count) throw badRequest('Add at least one sample before publishing.', 'empty_pack');
    // publishing twice keeps the original date
    await db.query('UPDATE packs SET published_at = coalesce(published_at, $2), updated_at = $2 WHERE id = $1', [pack.id, now()]);
    return { ...packJson(await find(db, pack.id, user)), samples: await samplesOf(pack.id) };
  });

  app.get('/api/packs/:id/samples/:sid/data', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const pack = await find(db, id, req.user);
    const { rows } = await db.query('SELECT * FROM pack_samples WHERE id = $1 AND pack_id = $2', [sid, pack.id]);
    if (!rows.length) throw notFound('Sample');
    const s = rows[0];
    const ext = `.${s.format}`;
    const base = s.name.toLowerCase().endsWith(ext) ? s.name.slice(0, -ext.length) : s.name;
    return ctx.sendObject(reply, s.storage_key, { type: AUDIO_MIME[s.format as AudioFormat], size: Number(s.size), disposition: attachment(base, ext) });
  });

  app.delete('/api/packs/:id', signedIn, async (req, reply) => {
    const user = req.user!;
    const pack = await find(db, (req.params as { id: string }).id, user);
    if (pack.user_id !== user.id && !user.isAdmin) throw forbidden('Only the owner can delete this pack.');
    const keys = await db.tx(async (q) => {
      if (pack.user_id !== user.id) await ctx.audit(q, user, 'pack.remove', 'pack', pack.id, pack.name);
      return removePack(q, pack.id);
    });
    await ctx.discard(keys);
    return reply.code(204).send();
  });
}
