// Cloud saves. A project is a name plus a run of numbered versions, each one
// an opaque .loopwell file in object storage. Saving never overwrites: it adds
// a version and trims the oldest beyond the configured count.

import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db.ts';
import { uploadBody, type Ctx } from '../server.ts';
import { readAll } from '../storage.ts';
import { attachment, badRequest, isZip, newId, notFound, optInt, optStr, type Bag } from '../util.ts';

const FILE_TYPE = 'application/octet-stream';

function projectJson(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    size: Number(row.size),
    versionCount: row.version_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT p.*, (SELECT count(*) FROM project_versions v WHERE v.project_id = p.id)::int AS version_count FROM projects p`;

export function projectRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, storage, now } = ctx;
  const limits = ctx.config.limits;
  const upload = { config: { auth: 'user', rate: 'upload' }, bodyLimit: limits.projectBytes } as const;
  const signedIn = { config: { auth: 'user' } } as const;

  const projectName = (query: Bag) => optStr(query, 'name', { max: 100, line: true });

  function projectFile(body: Buffer): Buffer {
    if (!isZip(body)) throw badRequest('That is not a Loopwell project file.', 'invalid_project');
    return body;
  }

  /** The caller's own project; anyone else's looks like it does not exist. */
  async function own(q: Queryable, id: string, userId: string, lock = false): Promise<Record<string, any>> {
    const { rows } = await q.query(`${SELECT} WHERE p.id = $1 AND p.user_id = $2${lock ? ' FOR UPDATE OF p' : ''}`, [id, userId]);
    if (!rows.length) throw notFound('Project');
    return rows[0];
  }

  /**
   * Stores `data` as the next version of a project and trims old versions.
   * Runs in one transaction so a quota failure leaves nothing behind.
   */
  async function addVersion(userId: string, projectId: string, data: Buffer, name: string | undefined): Promise<Record<string, any>> {
    const key = `projects/${projectId}/${newId()}`;
    await storage.put(key, data);
    let stale: string[] = [];
    try {
      const row = await db.tx(async (q) => {
        await ctx.lockUser(q, userId);
        const project = await own(q, projectId, userId);
        const n = project.version + 1;
        const t = now();
        await q.query('INSERT INTO project_versions (project_id, n, size, storage_key, created_at) VALUES ($1, $2, $3, $4, $5)', [projectId, n, data.length, key, t]);
        await q.query('UPDATE projects SET version = $2, size = $3, name = coalesce($4, name), updated_at = $5 WHERE id = $1', [projectId, n, data.length, name || null, t]);
        const trimmed = await q.query(
          `DELETE FROM project_versions WHERE project_id = $1 AND n NOT IN
             (SELECT n FROM project_versions WHERE project_id = $1 ORDER BY n DESC LIMIT $2)
           RETURNING storage_key`,
          [projectId, limits.projectVersions],
        );
        await ctx.checkQuota(q, userId);
        stale = trimmed.rows.map((r) => r.storage_key);
        return own(q, projectId, userId);
      });
      await ctx.discard(stale);
      return row;
    } catch (err) {
      await ctx.discard([key]);
      throw err;
    }
  }

  async function version(projectId: string, userId: string, n: unknown): Promise<Record<string, any>> {
    const num = optInt({ n }, 'n', 1, 2 ** 31 - 1);
    const { rows } = await db.query(
      'SELECT v.*, p.name FROM project_versions v JOIN projects p ON p.id = v.project_id WHERE p.id = $1 AND p.user_id = $2 AND v.n = $3',
      [projectId, userId, num ?? 0],
    );
    if (!rows.length) throw notFound('Version');
    return rows[0];
  }

  app.get('/api/projects', signedIn, async (req) => {
    const { rows } = await db.query(`${SELECT} WHERE p.user_id = $1 ORDER BY p.updated_at DESC, p.id`, [req.user!.id]);
    return { items: rows.map(projectJson) };
  });

  app.post('/api/projects', upload, async (req, reply) => {
    const data = projectFile(uploadBody(req));
    const userId = req.user!.id;
    const id = newId();
    const t = now();
    // an empty shell first, then the same path every later save takes
    await db.query('INSERT INTO projects (id, user_id, name, version, size, created_at, updated_at) VALUES ($1, $2, $3, 0, 0, $4, $4)', [
      id, userId, projectName(req.query as Bag) || 'Untitled', t,
    ]);
    try {
      return reply.code(201).send(projectJson(await addVersion(userId, id, data, undefined)));
    } catch (err) {
      await db.query('DELETE FROM projects WHERE id = $1', [id]);
      throw err;
    }
  });

  app.get('/api/projects/:id', signedIn, async (req) => {
    return projectJson(await own(db, (req.params as { id: string }).id, req.user!.id));
  });

  app.get('/api/projects/:id/data', signedIn, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await own(db, id, req.user!.id);
    const v = await version(id, req.user!.id, project.version);
    return ctx.sendObject(reply, v.storage_key, { type: FILE_TYPE, size: Number(v.size), disposition: attachment(project.name, '.loopwell') });
  });

  app.put('/api/projects/:id', upload, async (req) => {
    const data = projectFile(uploadBody(req));
    const { id } = req.params as { id: string };
    await own(db, id, req.user!.id);
    return projectJson(await addVersion(req.user!.id, id, data, projectName(req.query as Bag)));
  });

  app.delete('/api/projects/:id', signedIn, async (req, reply) => {
    const { id } = req.params as { id: string };
    const keys = await db.tx(async (q) => {
      await own(q, id, req.user!.id, true);
      const stored = await q.query('SELECT storage_key FROM project_versions WHERE project_id = $1', [id]);
      await q.query('DELETE FROM projects WHERE id = $1', [id]);
      return stored.rows.map((r) => r.storage_key as string);
    });
    await ctx.discard(keys);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/versions', signedIn, async (req) => {
    const { id } = req.params as { id: string };
    const project = await own(db, id, req.user!.id);
    const { rows } = await db.query('SELECT n, size, created_at FROM project_versions WHERE project_id = $1 ORDER BY n DESC', [id]);
    return { items: rows.map((r) => ({ n: r.n, size: Number(r.size), createdAt: r.created_at, current: r.n === project.version })) };
  });

  app.get('/api/projects/:id/versions/:n/data', signedIn, async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const v = await version(id, req.user!.id, n);
    return ctx.sendObject(reply, v.storage_key, { type: FILE_TYPE, size: Number(v.size), disposition: attachment(`${v.name}-v${v.n}`, '.loopwell') });
  });

  // Restoring copies the old version forward as a new one, so nothing is lost.
  app.post('/api/projects/:id/versions/:n/restore', { config: { auth: 'user', rate: 'upload' } }, async (req) => {
    const { id, n } = req.params as { id: string; n: string };
    const v = await version(id, req.user!.id, n);
    const data = await readAll(await storage.get(v.storage_key));
    return projectJson(await addVersion(req.user!.id, id, data, undefined));
  });
}
