// Reports from users and what admins do about them. Every admin action lands
// in the audit log.

import type { FastifyInstance } from 'fastify';
import { type Ctx } from '../server.ts';
import {
  HttpError, bag, badRequest, decodeCursor, encodeCursor, newId, notFound, oneOf, optStr, pageLimit, type Bag,
} from '../util.ts';
import { removeBeat } from './beats.ts';
import { removePack } from './packs.ts';

export const TARGET_TYPES = ['beat', 'pack', 'user'] as const;
export const REASONS = ['spam', 'abuse', 'copyright', 'explicit', 'other'] as const;
export const ACTIONS = ['dismiss', 'hide', 'remove', 'ban'] as const;
type TargetType = (typeof TARGET_TYPES)[number];

// Reports store ids; this resolves each one back to something an admin can read.
const REPORT_SELECT = `
  SELECT r.*, ru.handle AS reporter_handle, au.handle AS resolver_handle,
         tb.title AS beat_title, tb.hidden_at AS beat_hidden, tbu.handle AS beat_owner,
         tk.name AS pack_name, tk.hidden_at AS pack_hidden, tku.handle AS pack_owner,
         tu.handle AS user_handle, tu.banned_at AS user_banned
    FROM reports r
    JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN users au ON au.id = r.resolved_by
    LEFT JOIN (beats tb JOIN users tbu ON tbu.id = tb.user_id) ON r.target_type = 'beat' AND tb.id = r.target_id
    LEFT JOIN (packs tk JOIN users tku ON tku.id = tk.user_id) ON r.target_type = 'pack' AND tk.id = r.target_id
    LEFT JOIN users tu ON r.target_type = 'user' AND tu.id = r.target_id`;

function reportJson(r: Record<string, any>) {
  const target = r.target_type === 'beat'
    ? { exists: r.beat_title !== null, label: r.beat_title, owner: r.beat_owner, hidden: !!r.beat_hidden }
    : r.target_type === 'pack'
      ? { exists: r.pack_name !== null, label: r.pack_name, owner: r.pack_owner, hidden: !!r.pack_hidden }
      : { exists: r.user_handle !== null, label: r.user_handle, owner: r.user_handle, banned: !!r.user_banned };
  return {
    id: r.id,
    reporter: r.reporter_handle,
    // users are addressed by handle everywhere in the API
    targetType: r.target_type,
    targetId: r.target_type === 'user' ? r.user_handle ?? r.target_id : r.target_id,
    target,
    reason: r.reason,
    details: r.details,
    status: r.status,
    resolution: r.resolution,
    note: r.resolution_note,
    resolvedBy: r.resolver_handle,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

export function moderationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { config, db, now } = ctx;
  const admin = { config: { auth: 'admin' } } as const;

  app.post('/api/reports', { config: { auth: 'user' } }, async (req, reply) => {
    const user = req.user!;
    const body = bag(req.body);
    const targetType = oneOf(body, 'targetType', TARGET_TYPES);
    const rawId = optStr(body, 'targetId', { max: 60, min: 1, line: true });
    if (!rawId) throw badRequest('"targetId" is required.');
    const reason = oneOf(body, 'reason', REASONS);
    const details = optStr(body, 'details', { max: 1000 }) ?? '';

    // only things the public can see can be reported
    const lookup: Record<TargetType, string> = {
      beat: 'SELECT b.id, b.user_id AS owner FROM beats b JOIN users u ON u.id = b.user_id WHERE b.id = $1 AND b.hidden_at IS NULL AND u.banned_at IS NULL',
      pack: 'SELECT k.id, k.user_id AS owner FROM packs k JOIN users u ON u.id = k.user_id WHERE k.id = $1 AND k.published_at IS NOT NULL AND k.hidden_at IS NULL AND u.banned_at IS NULL',
      user: 'SELECT id, id AS owner FROM users WHERE handle = $1 AND banned_at IS NULL',
    };
    const found = await db.query(lookup[targetType], [targetType === 'user' ? rawId.toLowerCase() : rawId]);
    if (!found.rows.length) throw new HttpError(404, 'not_found', `No such ${targetType}.`);
    const target = found.rows[0];
    if (target.owner === user.id) throw badRequest('You cannot report yourself or your own uploads.', 'own_content');

    const open = await db.query(
      "SELECT 1 FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'open'",
      [user.id, targetType, target.id],
    );
    const duplicate = () => new HttpError(409, 'already_reported', 'You already have an open report for this.');
    if (open.rows.length) throw duplicate();

    const limit = ctx.limiter.hit(`report:${user.id}`, config.rate.reportsPerHour, 3_600_000, now().getTime());
    if (!limit.ok) {
      reply.header('retry-after', limit.retryAfter);
      throw new HttpError(429, 'rate_limited', 'You are sending reports too quickly. Try again later.');
    }

    const id = newId();
    try {
      await db.query(
        'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, user.id, targetType, target.id, reason, details, now()],
      );
    } catch (err) {
      // two identical requests racing each other; the unique index settles it
      if ((err as { code?: string }).code === '23505') throw duplicate();
      throw err;
    }
    return reply.code(201).send({ id, targetType, targetId: rawId, reason, details, status: 'open' });
  });

  app.get('/api/admin/reports', admin, async (req) => {
    const query = req.query as Bag;
    const status = query.status === undefined ? 'open' : oneOf(query, 'status', ['open', 'resolved'] as const);
    const limit = pageLimit(query, 50);
    const params: unknown[] = [status];
    let after = '';
    const cursor = optStr(query, 'cursor', { max: 300 });
    if (cursor) {
      params.push(...decodeCursor(cursor, ['string', 'string']));
      after = 'AND (r.created_at, r.id) < ($2::timestamptz, $3)';
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `${REPORT_SELECT} WHERE r.status = $1 ${after} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(reportJson),
      nextCursor: rows.length > limit ? encodeCursor([(last.created_at as Date).toISOString(), last.id]) : null,
    };
  });

  app.post('/api/admin/reports/:id/resolve', admin, async (req) => {
    const me = req.user!;
    const { id } = req.params as { id: string };
    const body = bag(req.body);
    const action = oneOf(body, 'action', ACTIONS);
    const note = optStr(body, 'note', { max: 1000 }) ?? '';

    const keys = await db.tx(async (q) => {
      const { rows } = await q.query(`${REPORT_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id]);
      const report = rows[0];
      if (!report) throw notFound('Report');
      if (report.status !== 'open') throw new HttpError(409, 'already_resolved', 'This report was already resolved.');
      const type = report.target_type as TargetType;
      const info = reportJson(report).target;
      const gone = () => new HttpError(409, 'target_gone', 'The reported content no longer exists. Dismiss the report instead.');
      let stored: string[] = [];
      // what the audit entry points at; a ban points at the person
      let auditType: string = type;
      let auditId: string = type === 'user' ? report.user_handle ?? report.target_id : report.target_id;

      if (action === 'hide' || action === 'remove') {
        if (type === 'user') throw badRequest(`"${action}" applies to beats and packs. For a user, use "ban" or "dismiss".`, 'invalid_action');
        if (!info.exists) throw gone();
        if (action === 'hide') {
          await q.query(`UPDATE ${type === 'beat' ? 'beats' : 'packs'} SET hidden_at = coalesce(hidden_at, $2) WHERE id = $1`, [report.target_id, now()]);
        } else {
          stored = type === 'beat' ? await removeBeat(q, report.target_id) : await removePack(q, report.target_id);
        }
      } else if (action === 'ban') {
        if (!info.exists) throw gone();
        const banned = await q.query('SELECT id, handle, is_admin FROM users WHERE handle = $1', [info.owner]);
        const target = banned.rows[0];
        if (target.is_admin || config.adminHandles.includes(target.handle)) throw badRequest('Admins cannot be banned.', 'invalid_action');
        await q.query('UPDATE users SET banned_at = coalesce(banned_at, $2) WHERE id = $1', [target.id, now()]);
        // signs them out everywhere
        await q.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
        await q.query('DELETE FROM auth_codes WHERE user_id = $1', [target.id]);
        auditType = 'user';
        auditId = target.handle;
      }

      // one decision settles every open report about the same thing
      await q.query(
        `UPDATE reports SET status = 'resolved', resolution = $1, resolution_note = $2, resolved_by = $3, resolved_at = $4
          WHERE status = 'open' AND target_type = $5 AND target_id = $6`,
        [action, note, me.id, now(), type, report.target_id],
      );
      await ctx.audit(q, me, `report.${action}`, auditType, auditId, note);
      return stored;
    });
    await ctx.discard(keys);
    const { rows } = await db.query(`${REPORT_SELECT} WHERE r.id = $1`, [id]);
    return reportJson(rows[0]);
  });

  for (const [kind, table] of [['beat', 'beats'], ['pack', 'packs']] as const) {
    app.post(`/api/admin/${table}/:id/unhide`, admin, async (req) => {
      const { id } = req.params as { id: string };
      await db.tx(async (q) => {
        const { rows } = await q.query(`UPDATE ${table} SET hidden_at = NULL WHERE id = $1 RETURNING id`, [id]);
        if (!rows.length) throw notFound(kind === 'beat' ? 'Beat' : 'Pack');
        await ctx.audit(q, req.user!, `${kind}.unhide`, kind, id);
      });
      return { id, hidden: false };
    });
  }

  app.post('/api/admin/users/:handle/unban', admin, async (req) => {
    const handle = (req.params as { handle: string }).handle.toLowerCase();
    await db.tx(async (q) => {
      const { rows } = await q.query('UPDATE users SET banned_at = NULL WHERE handle = $1 RETURNING id', [handle]);
      if (!rows.length) throw notFound('User');
      await ctx.audit(q, req.user!, 'user.unban', 'user', handle);
    });
    return { handle, banned: false };
  });

  app.get('/api/admin/audit', admin, async (req) => {
    const query = req.query as Bag;
    const limit = pageLimit(query, 50);
    const cursor = optStr(query, 'cursor', { max: 300 });
    const before = cursor ? (decodeCursor(cursor, ['number'])[0] as number) : Number.MAX_SAFE_INTEGER;
    const { rows } = await db.query('SELECT * FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT $2', [before, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: Number(r.id), admin: r.admin_handle, action: r.action, targetType: r.target_type, targetId: r.target_id, note: r.note, createdAt: r.created_at,
      })),
      nextCursor: rows.length > limit ? encodeCursor([Number(page[page.length - 1].id)]) : null,
    };
  });
}
