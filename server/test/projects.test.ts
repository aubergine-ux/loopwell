import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, zip, type Rig } from './helpers.ts';

let r: Rig;
let ann: string;
let bob: string;

beforeAll(async () => {
  // tiny limits so the edges are cheap to reach: 4 KB files, 3 versions, 10 KB per user
  r = await rig({ MAX_PROJECT_MB: String(4 / 1024), MAX_PROJECT_VERSIONS: '3', USER_QUOTA_MB: String(10 / 1024) });
  ann = await r.login('ann');
  bob = await r.login('bob');
});

afterAll(() => r.close());

describe('cloud saves', () => {
  it('saves, lists and downloads a project', async () => {
    const data = zip(500, 7);
    const created = await r.call('POST', '/api/projects?name=First%20light', { token: ann, bytes: data });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'First light', version: 1, size: 500, versionCount: 1 });

    const list = await r.call('GET', '/api/projects', { token: ann });
    expect(list.body.items.map((p: any) => p.id)).toEqual([created.body.id]);
    expect((await r.call('GET', `/api/projects/${created.body.id}`, { token: ann })).body).toEqual(created.body);

    const file = await r.call('GET', `/api/projects/${created.body.id}/data`, { token: ann });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toBe('attachment; filename="first-light.loopwell"');
    expect(file.raw.equals(data)).toBe(true);
    await r.call('DELETE', `/api/projects/${created.body.id}`, { token: ann });
  });

  it('keeps a version history, trims it, and restores old versions', async () => {
    const { body: p } = await r.call('POST', '/api/projects', { token: ann, bytes: zip(300, 1) });
    expect(p.name).toBe('Untitled');
    for (const n of [2, 3, 4]) {
      const saved = await r.call('PUT', `/api/projects/${p.id}${n === 3 ? '?name=Renamed' : ''}`, { token: ann, bytes: zip(300 + n, n) });
      expect(saved.status).toBe(200);
      expect(saved.body.version).toBe(n);
    }
    // only the newest three survive, and the trimmed file is gone from storage
    const versions = await r.call('GET', `/api/projects/${p.id}/versions`, { token: ann });
    expect(versions.body.items.map((v: any) => [v.n, v.size, v.current])).toEqual([[4, 304, true], [3, 303, false], [2, 302, false]]);
    expect((await r.stored()).length).toBe(3);
    expect((await r.call('GET', `/api/projects/${p.id}/versions/1/data`, { token: ann })).status).toBe(404);
    expect((await r.call('GET', `/api/projects/${p.id}`, { token: ann })).body).toMatchObject({ name: 'Renamed', version: 4, size: 304, versionCount: 3 });

    const old = await r.call('GET', `/api/projects/${p.id}/versions/2/data`, { token: ann });
    expect(old.raw.equals(zip(302, 2))).toBe(true);
    expect(old.headers['content-disposition']).toContain('renamed-v2.loopwell');

    // restoring copies version 2 forward as version 5
    const restored = await r.call('POST', `/api/projects/${p.id}/versions/2/restore`, { token: ann });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ version: 5, size: 302, versionCount: 3 });
    expect((await r.call('GET', `/api/projects/${p.id}/data`, { token: ann })).raw.equals(zip(302, 2))).toBe(true);
    const after = await r.call('GET', `/api/projects/${p.id}/versions`, { token: ann });
    expect(after.body.items.map((v: any) => v.n)).toEqual([5, 4, 3]);

    expect((await r.call('POST', `/api/projects/${p.id}/versions/99/restore`, { token: ann })).status).toBe(404);
    expect((await r.call('GET', `/api/projects/${p.id}/versions/abc/data`, { token: ann })).status).toBe(400);

    expect((await r.call('DELETE', `/api/projects/${p.id}`, { token: ann })).status).toBe(204);
    expect((await r.call('GET', `/api/projects/${p.id}`, { token: ann })).status).toBe(404);
    expect(await r.stored()).toEqual([]);
  });

  it('rejects files that are not zips, are empty, or are too large', async () => {
    const notZip = await r.call('POST', '/api/projects', { token: ann, bytes: Buffer.alloc(100, 65) });
    expect(notZip.status).toBe(400);
    expect(notZip.body.error.code).toBe('invalid_project');

    const asJson = await r.call('POST', '/api/projects', { token: ann, json: { hello: 1 } });
    expect(asJson.status).toBe(415);
    expect((await r.call('POST', '/api/projects', { token: ann })).status).toBe(415);

    const big = await r.call('POST', '/api/projects', { token: ann, bytes: zip(4097) });
    expect(big.status).toBe(413);
    expect(big.body.error).toEqual({ code: 'payload_too_large', message: expect.stringContaining('4 KB') });
    expect((await r.call('POST', '/api/projects', { token: ann, bytes: zip(4096) })).status).toBe(201);

    const longName = await r.call('POST', `/api/projects?name=${'x'.repeat(101)}`, { token: ann, bytes: zip() });
    expect(longName.status).toBe(400);
    expect((await r.call('GET', '/api/projects', { token: ann })).body.items.length).toBe(1);
  });

  it('enforces the storage quota and leaves nothing behind when it refuses', async () => {
    const carol = await r.login('carol');
    const a = await r.call('POST', '/api/projects', { token: carol, bytes: zip(4000) });
    expect((await r.call('PUT', `/api/projects/${a.body.id}`, { token: carol, bytes: zip(4000) })).status).toBe(200);
    expect((await r.call('GET', '/api/me', { token: carol })).body.storage).toEqual({ used: 8000, quota: 10240 });
    const filesBefore = (await r.stored()).length;

    // 8000 + 4000 > 10240
    const over = await r.call('PUT', `/api/projects/${a.body.id}`, { token: carol, bytes: zip(4000) });
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe('quota_exceeded');
    const fresh = await r.call('POST', '/api/projects?name=No%20room', { token: carol, bytes: zip(4000) });
    expect(fresh.status).toBe(413);
    const restore = await r.call('POST', `/api/projects/${a.body.id}/versions/1/restore`, { token: carol });
    expect(restore.status).toBe(413);

    expect((await r.call('GET', `/api/projects/${a.body.id}`, { token: carol })).body).toMatchObject({ version: 2, versionCount: 2 });
    expect((await r.call('GET', '/api/projects', { token: carol })).body.items.length).toBe(1);
    expect((await r.stored()).length).toBe(filesBefore);
    expect((await r.call('GET', '/api/me', { token: carol })).body.storage.used).toBe(8000);

    // a small save still fits, and deleting frees the space
    expect((await r.call('PUT', `/api/projects/${a.body.id}`, { token: carol, bytes: zip(2000) })).status).toBe(200);
    await r.call('DELETE', `/api/projects/${a.body.id}`, { token: carol });
    expect((await r.call('GET', '/api/me', { token: carol })).body.storage.used).toBe(0);
  });

  it('counts a save that replaces the oldest version against the space it frees', async () => {
    const dave = await r.login('dave');
    const { body: p } = await r.call('POST', '/api/projects', { token: dave, bytes: zip(3000) });
    await r.call('PUT', `/api/projects/${p.id}`, { token: dave, bytes: zip(3000) });
    await r.call('PUT', `/api/projects/${p.id}`, { token: dave, bytes: zip(3000) });
    // 9000 used with the history full: the fourth save pushes out the first
    const fourth = await r.call('PUT', `/api/projects/${p.id}`, { token: dave, bytes: zip(3000) });
    expect(fourth.status).toBe(200);
    expect((await r.call('GET', '/api/me', { token: dave })).body.storage.used).toBe(9000);
  });

  it("hides other people's projects completely", async () => {
    const { body: p } = await r.call('POST', '/api/projects?name=Private', { token: bob, bytes: zip(200) });
    const before = (await r.stored()).length;
    const attempts: [string, string, Buffer?][] = [
      ['GET', `/api/projects/${p.id}`],
      ['GET', `/api/projects/${p.id}/data`],
      ['PUT', `/api/projects/${p.id}`, zip(100)],
      ['DELETE', `/api/projects/${p.id}`],
      ['GET', `/api/projects/${p.id}/versions`],
      ['GET', `/api/projects/${p.id}/versions/1/data`],
      ['POST', `/api/projects/${p.id}/versions/1/restore`],
    ];
    for (const [method, url, bytes] of attempts) {
      const res = await r.call(method, url, { token: ann, bytes });
      expect([method, url, res.status]).toEqual([method, url, 404]);
      expect((await r.call(method, url, { bytes })).status).toBe(401);
    }
    expect((await r.call('GET', '/api/projects', { token: ann })).body.items.some((x: any) => x.id === p.id)).toBe(false);
    expect((await r.call('GET', `/api/projects/${p.id}`, { token: bob })).body.version).toBe(1);
    expect((await r.stored()).length).toBe(before);
  });
});
