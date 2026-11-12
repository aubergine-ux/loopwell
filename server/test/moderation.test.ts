import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, wav, zip, type Rig } from './helpers.ts';

let r: Rig;
let ann: string;
let bob: string;
let cat: string;
let boss: string;

async function beat(token: string, title: string): Promise<string> {
  const res = await r.call('POST', `/api/beats?title=${encodeURIComponent(title)}&tags=reported`, { token, bytes: zip() });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function pack(token: string, name: string): Promise<string> {
  const res = await r.call('POST', '/api/packs', { token, json: { name, license: 'CC0-1.0' } });
  await r.call('POST', `/api/packs/${res.body.id}/samples?name=a.wav`, { token, bytes: wav() });
  expect((await r.call('POST', `/api/packs/${res.body.id}/publish`, { token })).status).toBe(200);
  return res.body.id;
}

async function report(token: string, targetType: string, targetId: string, reason = 'spam'): Promise<string> {
  const res = await r.call('POST', '/api/reports', { token, json: { targetType, targetId, reason, details: 'look at this' } });
  expect([res.status, res.body]).toEqual([201, expect.objectContaining({ status: 'open' })]);
  return res.body.id;
}

const resolve = (id: string, action: string, note = '', token = boss) =>
  r.call('POST', `/api/admin/reports/${id}/resolve`, { token, json: { action, note } });

const listed = async (token?: string) => (await r.call('GET', '/api/beats?tag=reported&limit=100', { token })).body.items.map((b: any) => b.id);

beforeAll(async () => {
  r = await rig();
  ann = await r.login('ann');
  bob = await r.login('bob');
  cat = await r.login('cat');
  boss = await r.login('boss');
});

afterAll(() => r.close());

describe('reports', () => {
  it('takes a report and shows it to admins', async () => {
    const id = await beat(ann, 'Reported once');
    const reportId = await report(bob, 'beat', id, 'copyright');
    const open = await r.call('GET', '/api/admin/reports', { token: boss });
    expect(open.status).toBe(200);
    expect(open.body.items[0]).toMatchObject({
      id: reportId, reporter: 'bob', targetType: 'beat', targetId: id, reason: 'copyright', details: 'look at this', status: 'open',
      target: { exists: true, label: 'Reported once', owner: 'ann', hidden: false }, resolution: null, resolvedBy: null,
    });
    expect((await r.call('GET', '/api/admin/reports?status=resolved', { token: boss })).body.items).toEqual([]);
    expect((await r.call('GET', '/api/admin/reports?status=weird', { token: boss })).status).toBe(400);
  });

  it('allows one open report per user per target', async () => {
    const id = await beat(ann, 'Reported twice');
    const first = await report(bob, 'beat', id);
    const dup = await r.call('POST', '/api/reports', { token: bob, json: { targetType: 'beat', targetId: id, reason: 'abuse' } });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'already_reported']);
    // someone else may report it too, and once it is resolved the first user may report again
    await report(cat, 'beat', id);
    expect((await resolve(first, 'dismiss')).status).toBe(200);
    await report(bob, 'beat', id);
  });

  it('validates the report and its target', async () => {
    const id = await beat(ann, 'Valid target');
    const post = (json: unknown, token: string | null = bob) => r.call('POST', '/api/reports', { token: token ?? undefined, json });
    expect((await post({ targetType: 'beat', targetId: id, reason: 'spam' }, null)).status).toBe(401);
    for (const json of [
      { targetType: 'song', targetId: id, reason: 'spam' },
      { targetType: 'beat', targetId: id, reason: 'boring' },
      { targetType: 'beat', reason: 'spam' },
      { targetType: 'beat', targetId: id, reason: 'spam', details: 'x'.repeat(1001) },
    ]) {
      expect((await post(json)).status).toBe(400);
    }
    for (const [targetType, targetId] of [['beat', 'nope'], ['pack', 'nope'], ['user', 'nobody']]) {
      expect((await post({ targetType, targetId, reason: 'spam' })).status).toBe(404);
    }
    const own = await post({ targetType: 'beat', targetId: id, reason: 'spam' }, ann);
    expect([own.status, own.body.error.code]).toEqual([400, 'own_content']);
    expect((await post({ targetType: 'user', targetId: 'bob', reason: 'spam' })).body.error.code).toBe('own_content');
  });

  it('rate limits reports per user', async () => {
    const tight = await rig({ RATE_LIMIT_REPORTS_PER_HOUR: '2' });
    try {
      const a = await tight.login('a');
      const b = await tight.login('b');
      const ids: string[] = [];
      for (const title of ['x', 'y', 'z']) {
        ids.push((await tight.call('POST', `/api/beats?title=${title}`, { token: a, bytes: zip() })).body.id);
      }
      const send = (id: string) => tight.call('POST', '/api/reports', { token: b, json: { targetType: 'beat', targetId: id, reason: 'spam' } });
      expect((await send(ids[0])).status).toBe(201);
      expect((await send(ids[1])).status).toBe(201);
      const third = await send(ids[2]);
      expect([third.status, third.body.error.code]).toEqual([429, 'rate_limited']);
      tight.clock.advance(3_600_000);
      expect((await send(ids[2])).status).toBe(201);
    } finally {
      await tight.close();
    }
  });
});

describe('admin access', () => {
  it('is closed to everyone else', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/admin/reports'],
      ['POST', '/api/admin/reports/x/resolve'],
      ['POST', '/api/admin/beats/x/unhide'],
      ['POST', '/api/admin/packs/x/unhide'],
      ['POST', '/api/admin/users/ann/unban'],
      ['GET', '/api/admin/audit'],
    ];
    for (const [method, url] of routes) {
      expect([url, (await r.call(method, url)).status]).toEqual([url, 401]);
      const res = await r.call(method, url, { token: ann, json: method === 'POST' ? { action: 'dismiss' } : undefined });
      expect([url, res.status, res.body.error.code]).toEqual([url, 403, 'forbidden']);
    }
  });

  it('honours is_admin in the database as well as ADMIN_HANDLES', async () => {
    const token = await r.login('deputy');
    expect((await r.call('GET', '/api/me', { token })).body.isAdmin).toBe(false);
    expect((await r.call('GET', '/api/me', { token: boss })).body.isAdmin).toBe(true);
    await r.db.query("UPDATE users SET is_admin = true WHERE handle = 'deputy'");
    expect((await r.call('GET', '/api/me', { token })).body.isAdmin).toBe(true);
    expect((await r.call('GET', '/api/admin/audit', { token })).status).toBe(200);
  });
});

describe('resolving reports', () => {
  it('dismiss closes the report and changes nothing else', async () => {
    const id = await beat(ann, 'Fine actually');
    const reportId = await report(bob, 'beat', id);
    const res = await resolve(reportId, 'dismiss', 'nothing wrong');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', resolution: 'dismiss', note: 'nothing wrong', resolvedBy: 'boss' });
    expect(res.body.resolvedAt).toBeTruthy();
    expect((await r.call('GET', `/api/beats/${id}`)).body.hidden).toBe(false);

    const twice = await resolve(reportId, 'hide');
    expect([twice.status, twice.body.error.code]).toEqual([409, 'already_resolved']);
    expect((await resolve('nope', 'dismiss')).status).toBe(404);
    expect((await resolve(reportId, 'explode')).status).toBe(400);
    const done = await r.call('GET', '/api/admin/reports?status=resolved', { token: boss });
    expect(done.body.items.some((x: any) => x.id === reportId)).toBe(true);
    const audit = await r.call('GET', '/api/admin/audit', { token: boss });
    expect(audit.body.items[0]).toMatchObject({ admin: 'boss', action: 'report.dismiss', targetType: 'beat', targetId: id, note: 'nothing wrong' });
  });

  it('hide removes a beat from public view but not from its owner or admins, and unhide restores it', async () => {
    const id = await beat(ann, 'Hide me');
    const remix = (await r.call('POST', `/api/beats?title=Remix&remixOf=${id}`, { token: bob, bytes: zip() })).body.id;
    const reportId = await report(bob, 'beat', id);
    const second = await report(cat, 'beat', id);
    const countBefore = (await r.call('GET', '/api/users/ann')).body.beatCount;
    expect((await resolve(reportId, 'hide', 'too loud')).status).toBe(200);

    // gone for the public and other users, everywhere it could show up
    for (const token of [undefined, bob]) {
      expect((await r.call('GET', `/api/beats/${id}`, { token })).status).toBe(404);
      expect((await r.call('GET', `/api/beats/${id}/data`, { token })).status).toBe(404);
      expect((await r.call('GET', `/api/beats/${id}/remixes`, { token })).status).toBe(404);
      expect((await r.call('POST', `/api/beats/${id}/play`, { token })).status).toBe(404);
      expect(await listed(token)).not.toContain(id);
    }
    expect((await r.call('PUT', `/api/beats/${id}/like`, { token: bob })).status).toBe(404);
    expect((await r.call('POST', `/api/beats?title=No&remixOf=${id}`, { token: bob, bytes: zip() })).status).toBe(400);
    expect((await r.call('POST', '/api/reports', { token: cat, json: { targetType: 'beat', targetId: id, reason: 'spam' } })).status).toBe(404);
    expect((await r.call('GET', '/api/users/ann')).body.beatCount).toBe(countBefore - 1);
    // credit to a hidden beat is not shown
    expect((await r.call('GET', `/api/beats/${remix}`)).body.remixOf).toBeNull();

    // still there for the owner and for admins, flagged as hidden
    for (const token of [ann, boss]) {
      const seen = await r.call('GET', `/api/beats/${id}`, { token });
      expect([seen.status, seen.body.hidden]).toEqual([200, true]);
      expect((await r.call('GET', `/api/beats/${id}/data`, { token })).status).toBe(200);
      expect(await listed(token)).toContain(id);
    }

    // the other open report on the same beat was settled by the same decision
    const resolved = (await r.call('GET', '/api/admin/reports?status=resolved', { token: boss })).body.items;
    expect(resolved.find((x: any) => x.id === second)).toMatchObject({ resolution: 'hide', resolvedBy: 'boss', target: { hidden: true } });

    const unhide = await r.call('POST', `/api/admin/beats/${id}/unhide`, { token: boss });
    expect(unhide.body).toEqual({ id, hidden: false });
    expect((await r.call('GET', `/api/beats/${id}`)).status).toBe(200);
    expect(await listed()).toContain(id);
    expect((await r.call('GET', `/api/beats/${remix}`)).body.remixOf.id).toBe(id);
    expect((await r.call('POST', '/api/admin/beats/nope/unhide', { token: boss })).status).toBe(404);
    const audit = (await r.call('GET', '/api/admin/audit?limit=2', { token: boss })).body.items;
    expect(audit.map((a: any) => [a.action, a.targetId])).toEqual([['beat.unhide', id], ['report.hide', id]]);
  });

  it('hide and unhide work for packs', async () => {
    const id = await pack(ann, 'Hidden kit');
    const sample = (await r.call('GET', `/api/packs/${id}`)).body.samples[0].id;
    expect((await resolve(await report(bob, 'pack', id), 'hide')).status).toBe(200);
    expect((await r.call('GET', `/api/packs/${id}`)).status).toBe(404);
    expect((await r.call('GET', `/api/packs/${id}/samples/${sample}/data`, { token: bob })).status).toBe(404);
    expect((await r.call('GET', '/api/packs')).body.items.map((p: any) => p.id)).not.toContain(id);
    for (const token of [ann, boss]) {
      expect((await r.call('GET', `/api/packs/${id}`, { token })).body.hidden).toBe(true);
      expect((await r.call('GET', '/api/packs', { token })).body.items.map((p: any) => p.id)).toContain(id);
    }
    expect((await r.call('POST', `/api/admin/packs/${id}/unhide`, { token: boss })).body).toEqual({ id, hidden: false });
    expect((await r.call('GET', `/api/packs/${id}`)).status).toBe(200);
    expect((await r.call('GET', '/api/packs')).body.items.map((p: any) => p.id)).toContain(id);
  });

  it('remove deletes the content and its files', async () => {
    const beatId = await beat(ann, 'Remove me');
    const packId = await pack(ann, 'Remove this kit');
    const files = (await r.stored()).length;
    const beatReport = await report(bob, 'beat', beatId);
    const stale = await report(cat, 'beat', beatId);
    expect((await resolve(beatReport, 'remove', 'stolen')).status).toBe(200);
    expect((await resolve(await report(bob, 'pack', packId), 'remove')).status).toBe(200);

    expect((await r.call('GET', `/api/beats/${beatId}`, { token: ann })).status).toBe(404);
    expect((await r.call('GET', `/api/packs/${packId}`, { token: ann })).status).toBe(404);
    expect((await r.stored()).length).toBe(files - 2);
    const resolved = (await r.call('GET', '/api/admin/reports?status=resolved', { token: boss })).body.items;
    expect(resolved.find((x: any) => x.id === stale)).toMatchObject({ resolution: 'remove', target: { exists: false } });
  });

  it('refuses actions that do not fit the target', async () => {
    const userReport = await report(bob, 'user', 'ann');
    for (const action of ['hide', 'remove']) {
      const res = await resolve(userReport, action);
      expect([res.status, res.body.error.code]).toEqual([400, 'invalid_action']);
    }
    expect((await resolve(userReport, 'dismiss')).status).toBe(200);

    // the author deleted the beat before anyone looked
    const id = await beat(ann, 'Deleted first');
    const late = await report(bob, 'beat', id);
    await r.call('DELETE', `/api/beats/${id}`, { token: ann });
    for (const action of ['hide', 'remove', 'ban']) {
      const res = await resolve(late, action);
      expect([res.status, res.body.error.code]).toEqual([409, 'target_gone']);
    }
    expect((await resolve(late, 'dismiss')).status).toBe(200);

    const admin = await report(bob, 'user', 'boss');
    const res = await resolve(admin, 'ban');
    expect([res.status, res.body.error.code]).toEqual([400, 'invalid_action']);
    expect((await r.call('GET', '/api/me', { token: boss })).status).toBe(200);
  });

  it('ban locks the account out and hides its content; unban restores both', async () => {
    const eve = await r.login('eve');
    const id = await beat(eve, 'By a banned user');
    const packId = await pack(eve, 'Banned kit');
    const reportId = await report(bob, 'beat', id, 'abuse');
    const res = await resolve(reportId, 'ban', 'repeat offender');
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe('ban');

    // signed out everywhere, and cannot get back in
    expect((await r.call('GET', '/api/me', { token: eve })).status).toBe(401);
    const login = await r.call('POST', '/api/auth/dev-login', { json: { handle: 'eve' } });
    expect([login.status, login.body.error.code]).toEqual([403, 'banned']);
    expect((await r.call('POST', '/api/beats?title=Again', { token: eve, bytes: zip() })).status).toBe(401);

    // a token that somehow survived is refused too
    await r.db.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) SELECT encode(sha256('leftover'::bytea), 'hex'), id, now(), '2999-01-01' FROM users WHERE handle = 'eve'");
    for (const [method, url, bytes] of [['GET', '/api/me'], ['POST', '/api/beats?title=Again', zip()], ['POST', '/api/projects', zip()]] as const) {
      const blocked = await r.call(method, url, { token: 'leftover', bytes });
      expect([url, blocked.status, blocked.body.error.code]).toEqual([url, 403, 'banned']);
    }

    // their uploads and profile disappear from public view
    expect((await r.call('GET', `/api/beats/${id}`)).status).toBe(404);
    expect(await listed()).not.toContain(id);
    expect((await r.call('GET', `/api/packs/${packId}`)).status).toBe(404);
    expect((await r.call('GET', '/api/users/eve')).status).toBe(404);
    expect((await r.call('GET', '/api/users/eve', { token: boss })).body.banned).toBe(true);
    expect((await r.call('GET', `/api/beats/${id}`, { token: boss })).status).toBe(200);
    expect((await r.call('GET', '/api/tags')).body.items.find((t: any) => t.tag === 'reported').count).toBe((await listed()).length);

    const audit = (await r.call('GET', '/api/admin/audit?limit=1', { token: boss })).body.items[0];
    expect(audit).toMatchObject({ admin: 'boss', action: 'report.ban', targetType: 'user', targetId: 'eve', note: 'repeat offender' });

    const unban = await r.call('POST', '/api/admin/users/EVE/unban', { token: boss });
    expect(unban.body).toEqual({ handle: 'eve', banned: false });
    const back = await r.login('eve');
    expect((await r.call('GET', '/api/me', { token: back })).status).toBe(200);
    expect((await r.call('GET', `/api/beats/${id}`)).status).toBe(200);
    expect((await r.call('GET', `/api/packs/${packId}`)).status).toBe(200);
    expect((await r.call('GET', '/api/users/eve')).status).toBe(200);
    expect((await r.call('POST', '/api/admin/users/nobody/unban', { token: boss })).status).toBe(404);
  });

  it('a banned user cannot finish an OAuth-style code exchange', async () => {
    const mal = await r.login('mal');
    expect((await resolve(await report(bob, 'user', 'mal'), 'ban')).status).toBe(200);
    expect((await r.call('GET', '/api/me', { token: mal })).status).toBe(401);
    // a one-time code issued just before the ban is useless afterwards
    await r.db.query("INSERT INTO auth_codes (code_hash, user_id, expires_at) SELECT encode(sha256('late-code'::bytea), 'hex'), id, '2999-01-01' FROM users WHERE handle = 'mal'");
    const res = await r.call('POST', '/api/auth/exchange', { json: { code: 'late-code' } });
    expect([res.status, res.body.error.code]).toEqual([403, 'banned']);
  });

  it('pages the audit log', async () => {
    const all = (await r.call('GET', '/api/admin/audit?limit=100', { token: boss })).body.items;
    expect(all.length).toBeGreaterThan(8);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await r.call('GET', `/api/admin/audit?limit=4${cursor ? `&cursor=${cursor}` : ''}`, { token: boss });
      seen.push(...page.body.items.map((a: any) => a.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((a: any) => a.id));
    const reports = await r.call('GET', '/api/admin/reports?status=resolved&limit=3', { token: boss });
    expect(reports.body.items.length).toBe(3);
    const next = await r.call('GET', `/api/admin/reports?status=resolved&limit=3&cursor=${reports.body.nextCursor}`, { token: boss });
    expect(next.body.items.length).toBeGreaterThan(0);
    expect(next.body.items.some((x: any) => reports.body.items.some((y: any) => y.id === x.id))).toBe(false);
  });
});
