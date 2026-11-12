// The one query interface the server uses. Production wraps a pg pool; the
// tests wrap an in-process Postgres with the same three methods.

import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs a script of several statements, no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// bigint columns hold byte counts well inside the safe integer range
pg.types.setTypeParser(20, Number);

function wrap(client: { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> }): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // an idle client dropping its connection must not take the process down
  pool.on('error', () => {});
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/** Applies every .sql file not yet recorded, in name order. Returns what ran. */
export async function migrate(db: Db, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    const ran = await db.tx(async (q) => {
      // serialise concurrent starts against the same database
      await q.query('SELECT pg_advisory_xact_lock(727274)');
      const seen = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (seen.rows.length) return false;
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
