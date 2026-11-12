// Keeps openapi.yaml honest: it must describe exactly the routes the server
// registers, with the right auth, and its schemas must match real responses.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { OPENAPI_FILE } from '../src/routes/docs.ts';
import { routesOf } from '../src/server.ts';
import { rig, wav, zip, type Rig } from './helpers.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let r: Rig;
let spec: any;

interface Op {
  method: string;
  path: string;
  op: any;
  item: any;
}

function operations(): Op[] {
  const out: Op[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const key of Object.keys(item)) {
      if (METHODS.includes(key)) out.push({ method: key.toUpperCase(), path, op: item[key], item });
    }
  }
  return out;
}

const deref = (o: any): any => (o && o.$ref ? o.$ref.slice(2).split('/').reduce((n: any, k: string) => n?.[k], spec) : o);

/** Required and allowed property names of a named schema, following allOf. */
function shape(name: string): { required: string[]; allowed: string[] } {
  const required: string[] = [];
  const allowed: string[] = [];
  const visit = (s: any) => {
    s = deref(s);
    required.push(...(s.required ?? []));
    allowed.push(...Object.keys(s.properties ?? {}));
    (s.allOf ?? []).forEach(visit);
  };
  visit(spec.components.schemas[name]);
  return { required, allowed };
}

function expectShape(body: any, name: string): void {
  const { required, allowed } = shape(name);
  const keys = Object.keys(body);
  expect({ schema: name, missing: required.filter((k) => !keys.includes(k)), undocumented: keys.filter((k) => !allowed.includes(k)) })
    .toEqual({ schema: name, missing: [], undocumented: [] });
}

beforeAll(async () => {
  r = await rig();
  spec = parse(await readFile(OPENAPI_FILE, 'utf8'));
});

afterAll(() => r.close());

describe('openapi.yaml', () => {
  it('lists exactly the routes the server registers', () => {
    const registered = routesOf(r.app).map((x) => `${x.method} ${x.path}`).sort();
    const documented = operations().map((x) => `${x.method} ${x.path}`).sort();
    expect(registered.length).toBeGreaterThan(40);
    expect(new Set(registered).size).toBe(registered.length);
    expect({ undocumented: registered.filter((x) => !documented.includes(x)), stale: documented.filter((x) => !registered.includes(x)) })
      .toEqual({ undocumented: [], stale: [] });
  });

  it('declares the path parameters each route really has', () => {
    for (const { method, path, op, item } of operations()) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const declared = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref).filter((p) => p.in === 'path');
      expect([method, path, declared.map((p) => p.name).sort()]).toEqual([method, path, inPath]);
      for (const p of declared) expect(p.required).toBe(true);
    }
  });

  it('marks auth the way the server enforces it', () => {
    const byKey = new Map(routesOf(r.app).map((x) => [`${x.method} ${x.path}`, x]));
    for (const { method, path, op } of operations()) {
      const route = byKey.get(`${method} ${path}`)!;
      const security: any[] = op.security;
      expect(Array.isArray(security), `${method} ${path} needs an explicit security`).toBe(true);
      const optional = security.length === 0 || security.some((s) => Object.keys(s).length === 0);
      expect([method, path, optional ? null : 'token']).toEqual([method, path, route.auth ? 'token' : null]);
      if (route.auth) {
        expect(security).toEqual([{ bearerAuth: [] }]);
        expect(op.responses, `${method} ${path} should document 401`).toHaveProperty('401');
      }
      if (route.auth === 'admin') {
        expect(op.responses, `${method} ${path} should document 403`).toHaveProperty('403');
        expect(op.summary).toContain('(admin)');
      }
    }
  });

  it('is well formed: unique ids, known tags, responses, resolvable references', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    const ids = operations().map((x) => x.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = spec.tags.map((t: any) => t.name);
    for (const { method, path, op } of operations()) {
      const where = `${method} ${path}`;
      expect(op.operationId, where).toBeTruthy();
      expect(op.summary, where).toBeTruthy();
      expect(op.tags?.length, where).toBe(1);
      expect(tags, where).toContain(op.tags[0]);
      expect(Object.keys(op.responses ?? {}).some((s) => /^[23]/.test(s)), where).toBe(true);
    }
    const refs: string[] = [];
    const walk = (node: any) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        if (typeof node.$ref === 'string') refs.push(node.$ref);
        Object.values(node).forEach(walk);
      }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of new Set(refs)) expect(deref({ $ref: ref }), ref).toBeTruthy();
  });

  it('is served as JSON, with a docs page', async () => {
    const json = await r.call('GET', '/api/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body).toEqual(spec);
    const page = await r.app.inject({ method: 'GET', url: '/api/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain("fetch('openapi.json')");
    // self-contained: nothing loaded from another host
    expect(page.body).not.toMatch(/(src|href)="https?:/);
  });

  it('describes the responses the server actually sends', async () => {
    const boss = await r.login('boss');
    const ann = await r.login('ann');
    const session = await r.call('POST', '/api/auth/dev-login', { json: { handle: 'ann' } });
    expectShape(session.body, 'Session');
    expectShape(session.body.user, 'User');
    expectShape((await r.call('GET', '/api/me', { token: ann })).body, 'Me');
    expectShape((await r.call('GET', '/api/users/ann')).body, 'Profile');
    expectShape((await r.call('GET', '/api/users/ann', { token: boss })).body, 'Profile');
    const config = (await r.call('GET', '/api/config')).body;
    expectShape(config, 'ServerConfig');
    expect(Object.keys(config.limits).sort()).toEqual([...spec.components.schemas.ServerConfig.properties.limits.required].sort());

    const project = (await r.call('POST', '/api/projects', { token: ann, bytes: zip() })).body;
    expectShape(project, 'Project');
    expectShape((await r.call('GET', `/api/projects/${project.id}/versions`, { token: ann })).body.items[0], 'ProjectVersion');

    const original = (await r.call('POST', '/api/beats?title=Original', { token: ann, bytes: zip() })).body;
    const remix = (await r.call('POST', `/api/beats?title=Remix&remixOf=${original.id}`, { token: boss, bytes: zip() })).body;
    expectShape(remix, 'Beat');
    expectShape(remix.remixOf, 'RemixCredit');
    expectShape(remix.author, 'Author');
    expectShape((await r.call('GET', '/api/beats')).body, 'BeatPage');
    expectShape((await r.call('PUT', `/api/beats/${original.id}/like`, { token: boss })).body, 'LikeState');

    const pack = (await r.call('POST', '/api/packs', { token: ann, json: { name: 'Kit', license: 'CC0-1.0' } })).body;
    expectShape(pack, 'PackDetail');
    expectShape((await r.call('POST', `/api/packs/${pack.id}/samples?name=a.wav`, { token: ann, bytes: wav() })).body, 'Sample');
    await r.call('POST', `/api/packs/${pack.id}/publish`, { token: ann });
    expectShape((await r.call('GET', '/api/packs')).body.items[0], 'Pack');

    for (const [targetType, targetId] of [['beat', original.id], ['pack', pack.id], ['user', 'ann']]) {
      const filed = await r.call('POST', '/api/reports', { token: boss, json: { targetType, targetId, reason: 'other' } });
      expect(filed.status).toBe(201);
    }
    const reports = (await r.call('GET', '/api/admin/reports', { token: boss })).body.items;
    expect(reports.length).toBe(3);
    for (const report of reports) {
      expectShape(report, 'Report');
      const target = spec.components.schemas.Report.properties.target;
      expect(Object.keys(report.target).filter((k) => !(k in target.properties))).toEqual([]);
      expect(target.required.filter((k: string) => !(k in report.target))).toEqual([]);
    }
    const resolved = await r.call('POST', `/api/admin/reports/${reports[0].id}/resolve`, { token: boss, json: { action: 'dismiss' } });
    expectShape(resolved.body, 'Report');
    expectShape((await r.call('POST', `/api/admin/beats/${original.id}/unhide`, { token: boss })).body, 'Unhidden');
    expectShape((await r.call('GET', '/api/admin/audit', { token: boss })).body.items[0], 'AuditEntry');
    expectShape((await r.call('GET', '/api/nope')).body, 'Error');
  });
});
