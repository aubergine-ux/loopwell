// Errors, ids, hashing, cursors and input validation shared by the routes.

import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Thrown anywhere in a handler; becomes `{error: {code, message}}`. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'invalid_input') => new HttpError(400, code, message);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`);
export const forbidden = (message = 'You are not allowed to do that.') => new HttpError(403, 'forbidden', message);

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A 16-character lowercase id, about 82 bits of randomness. */
export function newId(): string {
  let out = '';
  // 252 is the largest multiple of 36 below 256, so the modulo stays unbiased
  while (out.length < 16) {
    for (const b of randomBytes(24)) {
      if (b < 252 && out.length < 16) out += ID_ALPHABET[b % 36];
    }
  }
  return out;
}

export const randomToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string): string => createHmac('sha256', secret).update(s).digest('hex');

// --- cursors ---------------------------------------------------------------

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(raw: string, kinds: ('string' | 'number')[]): (string | number)[] {
  try {
    const parts = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === kinds.length && parts.every((p, i) => typeof p === kinds[i] && (kinds[i] === 'string' || Number.isFinite(p)))) {
      return parts;
    }
  } catch {
    // falls through
  }
  throw badRequest('The cursor is not valid.', 'invalid_cursor');
}

// --- validation ------------------------------------------------------------

export type Bag = Record<string, unknown>;

export function bag(v: unknown, what = 'Request body'): Bag {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw badRequest(`${what} must be a JSON object.`);
  return v as Bag;
}

// control characters other than tab and newline
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

interface StrOpts {
  max: number;
  min?: number;
  /** Collapse to one line. */
  line?: boolean;
}

/** A trimmed string, or undefined when the field is absent. */
export function optStr(src: Bag, name: string, opts: StrOpts): string | undefined {
  const raw = src[name];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw badRequest(`"${name}" must be a string.`);
  let s = raw.replace(CONTROL, '');
  s = (opts.line ? s.replace(/\s+/g, ' ') : s.replace(/\r\n?/g, '\n')).trim();
  if (s.length > opts.max) throw badRequest(`"${name}" must be at most ${opts.max} characters.`);
  if (s.length < (opts.min ?? 0)) throw badRequest(opts.min === 1 ? `"${name}" must not be empty.` : `"${name}" must be at least ${opts.min} characters.`);
  return s;
}

export function str(src: Bag, name: string, opts: StrOpts): string {
  const s = optStr(src, name, opts);
  if (s === undefined) throw badRequest(`"${name}" is required.`);
  return s;
}

/** An integer from JSON or a query string, or undefined when absent or blank. */
export function optInt(src: Bag, name: string, min: number, max: number): number | undefined {
  const raw = src[name];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(v) || v < min || v > max) throw badRequest(`"${name}" must be a whole number from ${min} to ${max}.`);
  return v;
}

export function oneOf<T extends string>(src: Bag, name: string, allowed: readonly T[]): T {
  const raw = src[name];
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw badRequest(`"${name}" must be one of: ${allowed.join(', ')}.`);
  return raw as T;
}

export const MAX_TAGS = 8;

/** Lowercase, dash-separated, de-duplicated tags. Accepts an array or "a,b,c". */
export function tags(raw: unknown, name = 'tags'): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw.flatMap((p) => (typeof p === 'string' ? p.split(',') : [p])) : typeof raw === 'string' ? raw.split(',') : null;
  if (!parts || parts.some((p) => typeof p !== 'string')) throw badRequest(`"${name}" must be a list of strings.`);
  const out: string[] = [];
  for (const p of parts as string[]) {
    const t = slug(p, 24);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw badRequest(`At most ${MAX_TAGS} tags are allowed.`);
  return out;
}

/** "Lo-Fi Hip Hop" -> "lo-fi-hip-hop". */
export function slug(s: string, max: number): string {
  return s.normalize('NFKD').toLowerCase().replace(/^[\s#]+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

export function httpUrl(src: Bag, name: string): string | undefined {
  const s = optStr(src, name, { max: 500, line: true });
  if (!s) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw badRequest(`"${name}" must be a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`"${name}" must be an http(s) URL.`);
  return url.toString();
}

/** Escapes LIKE wildcards so user text matches literally. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

export function pageLimit(query: Bag, fallback = 24, max = 100): number {
  return optInt(query, 'limit', 1, max) ?? fallback;
}

/** Loopwell project files are zips; that is all the server checks. */
export function isZip(b: Buffer): boolean {
  return b.length >= 22 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

/** A filename safe to put in a Content-Disposition header. */
export function attachment(name: string, ext: string): string {
  const base = slug(name, 60) || 'loopwell';
  return `attachment; filename="${base}${ext}"`;
}
