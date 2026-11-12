// Entry point: read the environment, connect, migrate, listen.

import { loadConfig } from './config.ts';
import { migrate, pgDb } from './db.ts';
import { attachRealtime } from './realtime.ts';
import { buildServer } from './server.ts';
import { createStorage } from './storage.ts';

const SWEEP_EVERY_MS = 10 * 60_000;

/** Postgres may still be starting when we are; give it a little while. */
async function waitFor<T>(what: string, attempt: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= tries) throw err;
      console.error(`waiting for ${what} (${(err as Error).message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.DEV_LOGIN && !config.devLogin && config.production) {
    console.error('DEV_LOGIN is ignored because NODE_ENV=production.');
  }

  const db = pgDb(config.databaseUrl);
  await waitFor('the database', () => db.query('SELECT 1'));
  const applied = await migrate(db);
  if (applied.length) console.error(`applied migrations: ${applied.join(', ')}`);

  const storage = createStorage(config.storage);
  await waitFor('object storage', () => storage.ready());

  const app = await buildServer({ config, db, storage });
  attachRealtime(app);
  const sweep = setInterval(() => {
    app.loopwell.sweep().catch((err) => app.log.error({ err }, 'sweep failed'));
  }, SWEEP_EVERY_MS);
  sweep.unref();

  const stop = async () => {
    clearInterval(sweep);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await app.listen({ host: config.host, port: config.port });
  if (config.devLogin) app.log.warn('DEV_LOGIN is on: anyone can sign in as any handle. Never expose this server to the internet.');
  if (!Object.keys(config.providers).length) app.log.warn('No OAuth provider is configured, so nobody can sign in. Set GITHUB_* or DISCORD_* (see .env.example).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
