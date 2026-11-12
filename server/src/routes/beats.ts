// The public gallery: published beats, likes, plays and remix credit.
//
// Publishing sends the .loopwell file as the request body and the metadata in
// the query string, the same shape cloud saves use.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Queryable } from '../db.ts';
import { uploadBody, type Ctx, type User } from '../server.ts';
import {
  attachment, badRequest, bag, decodeCursor, encodeCursor, forbidden, hmac, isZip, likePattern, newId, notFound,
  optInt, optStr, pageLimit, slug, tags, type Bag,
} from '../util.ts';

const SORTS = { new: 'created_at', top: 'likes', plays: 'plays' } as const;
type Sort = keyof typeof SORTS;

const PLAY_WINDOW_MS = 3_600_000;

// $1 is the viewer's id ('' when signed out), $2 whether they are an admin
const PUBLIC = (b: string, u: string) => `(${b}.hidden_at IS NULL AND ${u}.banned_at IS NULL)`;
const VISIBLE = `(${PUBLIC('b', 'u')} OR b.user_id = $1 OR $2::boolean)`;

// Credit only points at beats the public can still see.
const SELECT = `
  SELECT b.id, b.user_id, b.title, b.description, b.tags, b.genre, b.bpm, b.key, b.size, b.storage_key,
         b.plays, b.likes, b.hidden_at, b.created_at, b.updated_at,
         u.handle, u.display_name, u.avatar_url,
         EXISTS (SELECT 1 FROM beat_likes l WHERE l.beat_id = b.id AND l.user_id = $1) AS liked,
         (SELECT count(*) FROM beats r JOIN users ru ON ru.id = r.user_id
           WHERE r.remix_of = b.id AND ${PUBLIC('r', 'ru')})::int AS remix_count,
         p.id AS parent_id, p.title AS parent_title,
         pu.handle AS parent_handle, pu.display_name AS parent_name, pu.avatar_url AS parent_avatar,
         o.id AS root_id, o.title AS root_title,
         ou.handle AS root_handle, ou.display_name AS root_name, ou.avatar_url AS root_avatar
    FROM beats b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN (beats p JOIN users pu ON pu.id = p.user_id) ON p.id = b.remix_of AND ${PUBLIC('p', 'pu')}
    LEFT JOIN (beats o JOIN users ou ON ou.id = o.user_id) ON o.id = b.remix_root AND ${PUBLIC('o', 'ou')}`;

const author = (handle: string, displayName: string, avatarUrl: string | null) => ({ handle, displayName, avatarUrl: avatarUrl ?? null });

function beatJson(r: Record<string, any>) {
  const credit = (prefix: 'parent' | 'root') => r[`${prefix}_id`]
    ? { id: r[`${prefix}_id`], title: r[`${prefix}_title`], author: author(r[`${prefix}_handle`], r[`${prefix}_name`], r[`${prefix}_avatar`]) }
    : null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.tags,
    genre: r.genre,
    bpm: r.bpm,
    key: r.key,
    size: Number(r.size),
    author: author(r.handle, r.display_name, r.avatar_url),
    plays: r.plays,
    likes: r.likes,
    likedByMe: !!r.liked,
    remixCount: r.remix_count,
    remixOf: credit('parent'),
    remixRoot: credit('root'),
    hidden: !!r.hidden_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** "f# minor" -> "F# minor". A note name, then an optional scale or mode. */
function musicalKey(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === '') return null;
  const m = /^([a-gA-G])([#b]?)(?: ([a-zA-Z][a-zA-Z0-9 -]{0,23}))?$/.exec(raw);
  if (!m) throw badRequest('"key" must look like "C", "F# minor" or "Bb dorian".');
  return `${m[1].toUpperCase()}${m[2]}${m[3] ? ` ${m[3].toLowerCase()}` : ''}`;
}

/** Title, description, tags, genre, bpm and key from a query string or JSON body. */
function metadata(src: Bag) {
  const genre = optStr(src, 'genre', { max: 60, line: true });
  return {
    title: optStr(src, 'title', { max: 100, min: 1, line: true }),
    description: optStr(src, 'description', { max: 2000 }),
    tags: src.tags === undefined ? undefined : tags(src.tags),
    genre: genre === undefined ? undefined : slug(genre, 32) || null,
    bpm: src.bpm === '' || src.bpm === null ? null : optInt(src, 'bpm', 20, 400),
    key: musicalKey(optStr(src, 'key', { max: 30, line: true })),
  };
}

/** Deletes a beat's row and returns the storage key to discard afterwards. */
export async function removeBeat(q: Queryable, id: string): Promise<string[]> {
  const { rows } = await q.query('DELETE FROM beats WHERE id = $1 RETURNING storage_key', [id]);
  return rows.map((r) => r.storage_key);
}

export function beatRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, storage, now } = ctx;
  const signedIn = { config: { auth: 'user' } } as const;

  const viewer = (user: User | null): [string, boolean] => [user?.id ?? '', !!user?.isAdmin];

  /** A beat the viewer is allowed to see, or a 404. */
  async function find(q: Queryable, id: string, user: User | null): Promise<Record<string, any>> {
    const { rows } = await q.query(`${SELECT} WHERE b.id = $3 AND ${VISIBLE}`, [...viewer(user), id]);
    if (!rows.length) throw notFound('Beat');
    return rows[0];
  }

  /** The same, and the viewer must own it or be an admin. */
  async function findEditable(id: string, user: User): Promise<Record<string, any>> {
    const beat = await find(db, id, user);
    if (beat.user_id !== user.id && !user.isAdmin) throw forbidden('Only the author can change this beat.');
    return beat;
  }

  async function list(req: FastifyRequest, where: string[], params: unknown[]) {
    const query = req.query as Bag;
    const sort = (optStr(query, 'sort', { max: 10 }) ?? 'new') as Sort;
    if (!(sort in SORTS)) throw badRequest('"sort" must be one of: new, top, plays.');
    const limit = pageLimit(query);
    const column = `b.${SORTS[sort]}`;
    const cursor = optStr(query, 'cursor', { max: 300 });
    if (cursor) {
      // keyset pagination: everything strictly after the last row of the previous page
      const [value, id] = decodeCursor(cursor, [sort === 'new' ? 'string' : 'number', 'string']);
      params.push(value, id);
      where.push(`(${column}, b.id) < ($${params.length - 1}::${sort === 'new' ? 'timestamptz' : 'int'}, $${params.length})`);
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${column} DESC, b.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const value = last && (sort === 'new' ? (last.created_at as Date).toISOString() : (last[SORTS[sort]] as number));
    return { items: page.map(beatJson), nextCursor: rows.length > limit ? encodeCursor([value, last.id]) : null };
  }

  app.post('/api/beats', { config: { auth: 'user', rate: 'upload' }, bodyLimit: ctx.config.limits.projectBytes }, async (req, reply) => {
    const data = uploadBody(req);
    if (!isZip(data)) throw badRequest('That is not a Loopwell project file.', 'invalid_project');
    const query = req.query as Bag;
    const meta = metadata(query);
    if (!meta.title) throw badRequest('"title" is required.');
    const user = req.user!;

    let parent: Record<string, any> | null = null;
    const remixOf = optStr(query, 'remixOf', { max: 40 });
    if (remixOf) {
      const found = await db.query('SELECT b.id, b.remix_root FROM beats b JOIN users u ON u.id = b.user_id WHERE b.id = $3 AND ' + VISIBLE, [...viewer(user), remixOf]);
      if (!found.rows.length) throw badRequest('The beat this remixes does not exist.', 'invalid_remix');
      parent = found.rows[0];
    }

    const id = newId();
    const key = `beats/${id}`;
    await storage.put(key, data);
    try {
      await db.tx(async (q) => {
        await ctx.lockUser(q, user.id);
        const t = now();
        await q.query(
          `INSERT INTO beats (id, user_id, title, description, tags, genre, bpm, key, size, storage_key, remix_of, remix_root, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
          [id, user.id, meta.title, meta.description ?? '', meta.tags ?? [], meta.genre ?? null, meta.bpm ?? null, meta.key ?? null,
            data.length, key, parent?.id ?? null, parent ? parent.remix_root ?? parent.id : null, t],
        );
        await ctx.checkQuota(q, user.id);
      });
    } catch (err) {
      await ctx.discard([key]);
      throw err;
    }
    return reply.code(201).send(beatJson(await find(db, id, user)));
  });

  app.get('/api/beats', async (req) => {
    const query = req.query as Bag;
    const params: unknown[] = [...viewer(req.user)];
    const where = [VISIBLE];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    const tag = slug(optStr(query, 'tag', { max: 60 }) ?? '', 24);
    if (tag) add('? = ANY (b.tags)', tag);
    const genre = slug(optStr(query, 'genre', { max: 60 }) ?? '', 32);
    if (genre) add('b.genre = ?', genre);
    const key = musicalKey(optStr(query, 'key', { max: 30, line: true }));
    if (key) add('b.key = ?', key);
    const bpmMin = optInt(query, 'bpmMin', 0, 1000);
    if (bpmMin !== undefined) add('b.bpm >= ?', bpmMin);
    const bpmMax = optInt(query, 'bpmMax', 0, 1000);
    if (bpmMax !== undefined) add('b.bpm <= ?', bpmMax);
    const user = optStr(query, 'user', { max: 60 });
    if (user) add('u.handle = ?', user.toLowerCase());
    const q = optStr(query, 'q', { max: 100, line: true });
    if (q) {
      add('(b.title ILIKE ? OR b.description ILIKE ?)', likePattern(q));
      // a query that is exactly a tag matches too
      const asTag = slug(q, 24);
      if (asTag) {
        params.push(asTag);
        where[where.length - 1] = `(${where[where.length - 1]} OR $${params.length} = ANY (b.tags))`;
      }
    }
    return list(req, where, params);
  });

  app.get('/api/tags', async (req) => {
    const limit = pageLimit(req.query as Bag, 50, 200);
    const { rows } = await db.query(
      `SELECT t.tag, count(*)::int AS count
         FROM beats b JOIN users u ON u.id = b.user_id CROSS JOIN LATERAL unnest(b.tags) AS t (tag)
        WHERE ${PUBLIC('b', 'u')}
        GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT $1`,
      [limit],
    );
    return { items: rows.map((r) => ({ tag: r.tag, count: r.count })) };
  });

  app.get('/api/beats/:id', async (req) => beatJson(await find(db, (req.params as { id: string }).id, req.user)));

  app.get('/api/beats/:id/data', async (req, reply) => {
    const beat = await find(db, (req.params as { id: string }).id, req.user);
    return ctx.sendObject(reply, beat.storage_key, { type: 'application/octet-stream', size: Number(beat.size), disposition: attachment(beat.title, '.loopwell') });
  });

  app.get('/api/beats/:id/remixes', async (req) => {
    const beat = await find(db, (req.params as { id: string }).id, req.user);
    return list(req, [VISIBLE, 'b.remix_of = $3'], [...viewer(req.user), beat.id]);
  });

  app.post('/api/beats/:id/play', async (req) => {
    const beat = await find(db, (req.params as { id: string }).id, req.user);
    // the address only ever exists here as a keyed hash
    const client = hmac(ctx.config.ipHashSecret, req.ip);
    const t = now();
    return db.tx(async (q) => {
      const fresh = await q.query(
        `INSERT INTO beat_plays (beat_id, client_hash, played_at) VALUES ($1, $2, $3)
         ON CONFLICT (beat_id, client_hash) DO UPDATE SET played_at = EXCLUDED.played_at
           WHERE beat_plays.played_at <= $4
         RETURNING 1`,
        [beat.id, client, t, new Date(t.getTime() - PLAY_WINDOW_MS)],
      );
      if (!fresh.rows.length) return { plays: beat.plays as number, counted: false };
      const { rows } = await q.query('UPDATE beats SET plays = plays + 1 WHERE id = $1 RETURNING plays', [beat.id]);
      return { plays: rows[0].plays as number, counted: true };
    });
  });

  app.put('/api/beats/:id/like', signedIn, async (req) => {
    const beat = await find(db, (req.params as { id: string }).id, req.user);
    return db.tx(async (q) => {
      const added = await q.query(
        'INSERT INTO beat_likes (beat_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1',
        [beat.id, req.user!.id, now()],
      );
      const { rows } = await q.query('UPDATE beats SET likes = likes + $2 WHERE id = $1 RETURNING likes', [beat.id, added.rows.length]);
      return { likes: rows[0].likes as number, likedByMe: true };
    });
  });

  app.delete('/api/beats/:id/like', signedIn, async (req) => {
    const beat = await find(db, (req.params as { id: string }).id, req.user);
    return db.tx(async (q) => {
      const removed = await q.query('DELETE FROM beat_likes WHERE beat_id = $1 AND user_id = $2 RETURNING 1', [beat.id, req.user!.id]);
      const { rows } = await q.query('UPDATE beats SET likes = likes - $2 WHERE id = $1 RETURNING likes', [beat.id, removed.rows.length]);
      return { likes: rows[0].likes as number, likedByMe: false };
    });
  });

  app.patch('/api/beats/:id', signedIn, async (req) => {
    const user = req.user!;
    const beat = await findEditable((req.params as { id: string }).id, user);
    const meta = metadata(bag(req.body));
    const next = {
      title: meta.title ?? beat.title,
      description: meta.description ?? beat.description,
      tags: meta.tags ?? beat.tags,
      genre: meta.genre === undefined ? beat.genre : meta.genre,
      bpm: meta.bpm === undefined ? beat.bpm : meta.bpm,
      key: meta.key === undefined ? beat.key : meta.key,
    };
    await db.tx(async (q) => {
      await q.query(
        'UPDATE beats SET title = $2, description = $3, tags = $4::text[], genre = $5, bpm = $6, key = $7, updated_at = $8 WHERE id = $1',
        [beat.id, next.title, next.description, next.tags, next.genre, next.bpm, next.key, now()],
      );
      if (beat.user_id !== user.id) await ctx.audit(q, user, 'beat.edit', 'beat', beat.id);
    });
    return beatJson(await find(db, beat.id, user));
  });

  app.delete('/api/beats/:id', signedIn, async (req, reply) => {
    const user = req.user!;
    const beat = await findEditable((req.params as { id: string }).id, user);
    const keys = await db.tx(async (q) => {
      if (beat.user_id !== user.id) await ctx.audit(q, user, 'beat.remove', 'beat', beat.id, beat.title);
      return removeBeat(q, beat.id);
    });
    await ctx.discard(keys);
    return reply.code(204).send();
  });
}
