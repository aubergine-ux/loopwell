// Every setting comes from the environment. See .env.example at the repo root
// for the full list with explanations.

import { randomBytes } from 'node:crypto';

export type ProviderName = 'github' | 'discord';
export const PROVIDERS: readonly ProviderName[] = ['github', 'discord'];

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
}

export type StorageConfig =
  | { driver: 'fs'; dir: string }
  | {
      driver: 's3';
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface Limits {
  projectBytes: number;
  projectVersions: number;
  userQuotaBytes: number;
  sampleBytes: number;
  sampleSeconds: number;
  packFiles: number;
  packBytes: number;
}

export interface RateLimits {
  perMinute: number;
  authPerMinute: number;
  uploadsPerMinute: number;
  reportsPerHour: number;
}

export interface Config {
  production: boolean;
  host: string;
  port: number;
  publicUrl: string;
  appOrigins: string[];
  databaseUrl: string;
  storage: StorageConfig;
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  adminHandles: string[];
  devLogin: boolean;
  ipHashSecret: string;
  trustProxy: boolean;
  sessionTtlDays: number;
  limits: Limits;
  rate: RateLimits;
  log: boolean;
}

type Env = Record<string, string | undefined>;

const PROVIDER_DEFAULTS: Record<ProviderName, Pick<ProviderConfig, 'authorizeUrl' | 'tokenUrl' | 'userUrl' | 'scope'>> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user',
  },
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userUrl: 'https://discord.com/api/users/@me',
    scope: 'identify',
  },
};

function num(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be a number >= ${min}, got "${raw}"`);
  return v;
}

const flag = (env: Env, name: string): boolean => ['1', 'true', 'yes'].includes((env[name] ?? '').trim().toLowerCase());
const list = (raw: string | undefined): string[] => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const mb = (n: number) => Math.round(n * 1024 * 1024);

function origins(raw: string | undefined): string[] {
  return list(raw).map((o) => {
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new Error(`APP_ORIGINS entry "${o}" is not a URL`);
    }
    return url.origin;
  });
}

function provider(env: Env, name: ProviderName): ProviderConfig | undefined {
  const p = name.toUpperCase();
  const clientId = env[`${p}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${p}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) return undefined;
  const d = PROVIDER_DEFAULTS[name];
  return {
    clientId,
    clientSecret,
    authorizeUrl: env[`${p}_AUTHORIZE_URL`]?.trim() || d.authorizeUrl,
    tokenUrl: env[`${p}_TOKEN_URL`]?.trim() || d.tokenUrl,
    userUrl: env[`${p}_USER_URL`]?.trim() || d.userUrl,
    scope: d.scope,
  };
}

function storage(env: Env): StorageConfig {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return { driver: 'fs', dir: env.STORAGE_DIR?.trim() || './data/storage' };
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('S3_BUCKET is set, so S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  return {
    driver: 's3',
    endpoint,
    region: env.S3_REGION?.trim() || 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    // MinIO and most self-hosted stores want path-style addressing
    forcePathStyle: env.S3_FORCE_PATH_STYLE?.trim() ? flag(env, 'S3_FORCE_PATH_STYLE') : !!endpoint,
  };
}

export function loadConfig(env: Env = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = num(env, 'PORT', 8787, 1);
  const providers: Config['providers'] = {};
  for (const name of PROVIDERS) {
    const p = provider(env, name);
    if (p) providers[name] = p;
  }
  return {
    production,
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    publicUrl: (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, ''),
    appOrigins: origins(env.APP_ORIGINS?.trim() || 'http://localhost:5173'),
    databaseUrl: env.DATABASE_URL?.trim() || 'postgres://loopwell:loopwell@localhost:5432/loopwell',
    storage: storage(env),
    providers,
    adminHandles: list(env.ADMIN_HANDLES).map((h) => h.toLowerCase()),
    // the dev login hands out tokens without OAuth, so it never runs in production
    devLogin: flag(env, 'DEV_LOGIN') && !production,
    ipHashSecret: env.IP_HASH_SECRET?.trim() || randomBytes(32).toString('hex'),
    trustProxy: flag(env, 'TRUST_PROXY'),
    sessionTtlDays: num(env, 'SESSION_TTL_DAYS', 30, 1),
    limits: {
      projectBytes: mb(num(env, 'MAX_PROJECT_MB', 30, 0.001)),
      projectVersions: Math.floor(num(env, 'MAX_PROJECT_VERSIONS', 50, 1)),
      userQuotaBytes: mb(num(env, 'USER_QUOTA_MB', 1024, 0.001)),
      sampleBytes: mb(num(env, 'MAX_SAMPLE_MB', 10, 0.001)),
      sampleSeconds: num(env, 'MAX_SAMPLE_SECONDS', 60, 0.001),
      packFiles: Math.floor(num(env, 'MAX_PACK_FILES', 64, 1)),
      packBytes: mb(num(env, 'MAX_PACK_MB', 200, 0.001)),
    },
    rate: {
      perMinute: num(env, 'RATE_LIMIT_PER_MINUTE', 300, 1),
      authPerMinute: num(env, 'RATE_LIMIT_AUTH_PER_MINUTE', 30, 1),
      uploadsPerMinute: num(env, 'RATE_LIMIT_UPLOADS_PER_MINUTE', 60, 1),
      reportsPerHour: num(env, 'RATE_LIMIT_REPORTS_PER_HOUR', 10, 1),
    },
    log: env.LOG?.trim() ? flag(env, 'LOG') : true,
  };
}
