// Test rig: the real server over an in-process Postgres (PGlite), the
// filesystem storage driver in a temp directory, and a fake OAuth provider.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.ts';
import { migrate, type Db, type Queryable } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { FsStorage } from '../src/storage.ts';

export const APP_ORIGIN = 'http://app.test';
export const API_URL = 'http://api.test';

/** The same three methods the pg adapter has, over PGlite. */
export function pgliteDb(): Db {
  const pg = new PGlite();
  const wrap = (c: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query<T>(sql, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await c.exec(sql);
    },
  });
  return {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t as unknown as PGlite))) as Promise<any>,
    close: () => pg.close(),
  };
}

// --- fake OAuth provider ----------------------------------------------------

export interface FakeProvider {
  url: string;
  /** The profile the next authorization will sign in as. */
  profile: Record<string, unknown>;
  /** Makes the provider send the user back with ?error=access_denied. */
  deny: boolean;
  /** Token requests seen, for asserting what the server sent. */
  tokenRequests: Record<string, string>[];
  close(): Promise<void>;
}

/** Speaks just enough OAuth 2 for the code flow: authorize, token, user. */
export async function fakeProvider(): Promise<FakeProvider> {
  const codes = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fake');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (fake.deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${++n}`;
        codes.set(code, { profile: fake.profile, clientId: url.searchParams.get('client_id'), redirectUri: back.origin + back.pathname });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        fake.tokenRequests.push(form);
        const grant = codes.get(form.code);
        codes.delete(form.code);
        if (!grant || form.client_id !== grant.clientId || form.client_secret !== 'fake-secret' || form.redirect_uri !== grant.redirectUri) {
          return json(400, { error: 'bad_verification_code' });
        }
        const token = `tok-${++n}`;
        tokens.set(token, grant.profile as Record<string, unknown>);
        json(200, { access_token: token, token_type: 'bearer' });
      });
      return;
    }
    if (url.pathname === '/user') {
      const profile = tokens.get((req.headers.authorization ?? '').replace('Bearer ', ''));
      return profile ? json(200, profile) : json(401, { message: 'Bad credentials' });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const fake: FakeProvider = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    profile: {},
    deny: false,
    tokenRequests: [],
    close: () => new Promise((r) => server.close(() => r())),
  };
  return fake;
}

// --- the rig ---------------------------------------------------------------

export interface Res {
  status: number;
  headers: Record<string, any>;
  body: any;
  raw: Buffer;
}

export interface CallOpts {
  token?: string;
  json?: unknown;
  bytes?: Buffer;
  ip?: string;
  headers?: Record<string, string>;
}

export interface Rig {
  app: FastifyInstance;
  db: Db;
  config: Config;
  dir: string;
  clock: { advance(ms: number): void };
  call(method: string, url: string, opts?: CallOpts): Promise<Res>;
  /** Signs in through the dev login and returns the bearer token. */
  login(handle: string): Promise<string>;
  /** Every file currently in storage, as relative paths. */
  stored(): Promise<string[]>;
  close(): Promise<void>;
}

export async function rig(env: Record<string, string> = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'loopwell-test-'));
  const config = loadConfig({
    PUBLIC_URL: API_URL,
    APP_ORIGINS: APP_ORIGIN,
    STORAGE_DIR: dir,
    DEV_LOGIN: '1',
    LOG: '0',
    IP_HASH_SECRET: 'test-secret',
    ADMIN_HANDLES: 'boss',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    RATE_LIMIT_UPLOADS_PER_MINUTE: '100000',
    RATE_LIMIT_REPORTS_PER_HOUR: '100000',
    ...env,
  });
  const db = pgliteDb();
  await migrate(db);
  const storage = new FsStorage(dir);
  await storage.ready();

  // a clock that ticks on every read, so rows written in order sort in order
  let t = Date.parse('2026-03-01T12:00:00Z');
  const app = await buildServer({ config, db, storage, now: () => new Date((t += 1)) });

  const call: Rig['call'] = async (method, url, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let payload: Buffer | string | undefined;
    if (opts.bytes) {
      headers['content-type'] = 'application/octet-stream';
      payload = opts.bytes;
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(opts.json);
    }
    const res = await app.inject({ method: method as 'GET', url, headers, payload, remoteAddress: opts.ip ?? '10.0.0.1' });
    let body: any = null;
    if (String(res.headers['content-type'] ?? '').includes('json')) body = res.json();
    return { status: res.statusCode, headers: res.headers, body, raw: res.rawPayload };
  };

  async function walk(sub: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(join(dir, sub), { withFileTypes: true })) {
      const rel = join(sub, e.name);
      if (e.isDirectory()) out.push(...(await walk(rel)));
      else out.push(rel);
    }
    return out;
  }

  return {
    app,
    db,
    config,
    dir,
    clock: { advance: (ms) => void (t += ms) },
    call,
    async login(handle) {
      const res = await call('POST', '/api/auth/dev-login', { json: { handle } });
      if (res.status !== 200) throw new Error(`dev login failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.token;
    },
    stored: () => walk(''),
    async close() {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// --- fixtures --------------------------------------------------------------

/** Bytes that pass for a .loopwell file: zip magic, then filler. */
export function zip(size = 64, fill = 1): Buffer {
  const b = Buffer.alloc(Math.max(size, 22), fill);
  b.set([0x50, 0x4b, 3, 4]);
  return b;
}

export function wav(opts: { seconds?: number; channels?: number; sampleRate?: number; bits?: number } = {}): Buffer {
  const { seconds = 0.25, channels = 1, sampleRate = 8000, bits = 8 } = opts;
  const blockAlign = Math.max(1, channels) * (bits / 8);
  const dataBytes = Math.round(seconds * sampleRate) * blockAlign;
  const b = Buffer.alloc(44 + dataBytes, 0x80);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** An AIFF header claiming `seconds` of audio; the sample data itself is short. */
export function aiff(opts: { seconds?: number; channels?: number; sampleRate?: number } = {}): Buffer {
  const { seconds = 0.5, channels = 2, sampleRate = 44100 } = opts;
  const b = Buffer.alloc(12 + 26 + 16 + 64);
  b.write('FORM', 0, 'latin1');
  b.writeUInt32BE(b.length - 8, 4);
  b.write('AIFFCOMM', 8, 'latin1');
  b.writeUInt32BE(18, 16);
  b.writeInt16BE(channels, 20);
  b.writeUInt32BE(Math.round(seconds * sampleRate), 22);
  b.writeInt16BE(16, 26);
  // sample rate as an 80-bit extended float
  const exp = Math.floor(Math.log2(sampleRate));
  b.writeUInt16BE(16383 + exp, 28);
  const mantissa = BigInt(Math.round(sampleRate * 2 ** (63 - exp)));
  b.writeBigUInt64BE(mantissa, 30);
  b.write('SSND', 38, 'latin1');
  b.writeUInt32BE(72, 42);
  return b;
}

export function flac(opts: { seconds?: number; channels?: number; sampleRate?: number } = {}): Buffer {
  const { seconds = 1, channels = 2, sampleRate = 44100 } = opts;
  const b = Buffer.alloc(64);
  b.write('fLaC', 0, 'latin1');
  b[4] = 0x80; // last metadata block, type 0 (STREAMINFO)
  b.writeUIntBE(34, 5, 3);
  const samples = BigInt(Math.round(seconds * sampleRate));
  // 20 bits rate, 3 bits channels-1, 5 bits depth-1, 36 bits sample count
  const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (15n << 36n) | samples;
  b.writeBigUInt64BE(packed, 18);
  return b;
}

export const mp3 = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200)]);
export const mp3WithId3 = (): Buffer => Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(10), mp3()]);
export const ogg = (): Buffer => Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(100)]);
export const m4a = (): Buffer => Buffer.concat([Buffer.from('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00', 'latin1'), Buffer.alloc(100)]);
