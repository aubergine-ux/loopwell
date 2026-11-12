import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, zip, type Rig } from './helpers.ts';

let r: Rig;
let ann: string;
let bob: string;
let boss: string;

const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)])).toString();

async function publish(token: string, meta: Record<string, string | number>, bytes = zip(100)): Promise<any> {
  const res = await r.call('POST', `/api/beats?${qs(meta)}`, { token, bytes });
  expect(res.status).toBe(201);
  return res.body;
}

const titles = (res: { body: any }) => res.body.items.map((b: any) => b.title);

beforeAll(async () => {
  r = await rig();
  ann = await r.login('ann');
  bob = await r.login('bob');
  boss = await r.login('boss');
});

afterAll(() => r.close());

describe('publishing', () => {
  it('publishes a beat with normalised metadata and serves the file', async () => {
    const data = zip(321, 9);
    const beat = await publish(ann, {
      title: '  Night   Drive ', description: 'Slow one.', tags: 'Lo-Fi, #Chill,lo fi,  ,CHILL', genre: 'Hip Hop', bpm: 84, key: 'f# MINOR',
    }, data);
    expect(beat).toMatchObject({
      title: 'Night Drive', description: 'Slow one.', tags: ['lo-fi', 'chill'], genre: 'hip-hop', bpm: 84, key: 'F# minor', size: 321,
      author: { handle: 'ann', displayName: 'ann', avatarUrl: null },
      plays: 0, likes: 0, likedByMe: false, remixCount: 0, remixOf: null, remixRoot: null, hidden: false,
    });
    expect(beat.id).toMatch(/^[0-9a-z]{16}$/);

    const anon = await r.call('GET', `/api/beats/${beat.id}`);
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual(beat);
    const file = await r.call('GET', `/api/beats/${beat.id}/data`);
    expect(file.raw.equals(data)).toBe(true);
    expect(file.headers['content-disposition']).toBe('attachment; filename="night-drive.loopwell"');
    expect(Number(file.headers['content-length'])).toBe(321);
  });

  it('validates what it is given', async () => {
    const bad: [Record<string, string | number>, string][] = [
      [{}, 'invalid_input'],
      [{ title: 'x'.repeat(101) }, 'invalid_input'],
      [{ title: 'ok', bpm: 19 }, 'invalid_input'],
      [{ title: 'ok', bpm: 'fast' }, 'invalid_input'],
      [{ title: 'ok', key: 'H minor' }, 'invalid_input'],
      [{ title: 'ok', tags: 'a,b,c,d,e,f,g,h,i' }, 'invalid_input'],
      [{ title: 'ok', remixOf: 'doesnotexist' }, 'invalid_remix'],
    ];
    for (const [meta, code] of bad) {
      const res = await r.call('POST', `/api/beats?${qs(meta)}`, { token: ann, bytes: zip() });
      expect([meta, res.status, res.body.error.code]).toEqual([meta, 400, code]);
    }
    expect((await r.call('POST', '/api/beats?title=ok', { token: ann, bytes: Buffer.alloc(50, 1) })).body.error.code).toBe('invalid_project');
    expect((await r.call('POST', '/api/beats?title=ok', { bytes: zip() })).status).toBe(401);
    // eight tags is fine
    expect((await publish(ann, { title: 'Eight', tags: 'a,b,c,d,e,f,g,h' })).tags.length).toBe(8);
  });
});

describe('the gallery', () => {
  let g: Rig;
  let u1: string;
  let u2: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    g = await rig();
    u1 = await g.login('one');
    u2 = await g.login('two');
    const seed: [string, string, Record<string, string | number>][] = [
      ['A', u1, { tags: 'house,club', genre: 'house', bpm: 124, key: 'A minor', description: 'four on the floor' }],
      ['B', u1, { tags: 'lofi', genre: 'hip-hop', bpm: 80, key: 'C major' }],
      ['C', u2, { tags: 'house', genre: 'house', bpm: 128, key: 'A minor' }],
      ['D', u2, { tags: 'dnb', genre: 'drum-and-bass', bpm: 174 }],
      ['E', u2, { tags: 'lofi,house', bpm: 90, description: '100% chill_vibes' }],
    ];
    for (const [title, token, meta] of seed) {
      const res = await g.call('POST', `/api/beats?${qs({ title, ...meta })}`, { token, bytes: zip() });
      ids[title] = res.body.id;
    }
    // likes: C 2, A 1.  plays: D 3, B 1
    await g.call('PUT', `/api/beats/${ids.C}/like`, { token: u1 });
    await g.call('PUT', `/api/beats/${ids.C}/like`, { token: u2 });
    await g.call('PUT', `/api/beats/${ids.A}/like`, { token: u2 });
    for (const ip of ['1.1.1.1', '1.1.1.2', '1.1.1.3']) await g.call('POST', `/api/beats/${ids.D}/play`, { ip });
    await g.call('POST', `/api/beats/${ids.B}/play`, { ip: '1.1.1.1' });
  });

  afterAll(() => g.close());

  it('sorts by newest, likes and plays', async () => {
    expect(titles(await g.call('GET', '/api/beats'))).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(titles(await g.call('GET', '/api/beats?sort=top')).slice(0, 2)).toEqual(['C', 'A']);
    expect(titles(await g.call('GET', '/api/beats?sort=plays')).slice(0, 2)).toEqual(['D', 'B']);
    expect((await g.call('GET', '/api/beats?sort=random')).status).toBe(400);
  });

  it('filters by tag, genre, key, tempo, author and text', async () => {
    const get = async (query: string) => titles(await g.call('GET', `/api/beats?${query}`));
    expect(await get('tag=house')).toEqual(['E', 'C', 'A']);
    expect(await get('tag=%23House')).toEqual(['E', 'C', 'A']);
    expect(await get('genre=house')).toEqual(['C', 'A']);
    expect(await get('genre=Hip%20Hop')).toEqual(['B']);
    expect(await get('key=a%20minor')).toEqual(['C', 'A']);
    expect(await get('bpmMin=90&bpmMax=128')).toEqual(['E', 'C', 'A']);
    expect(await get('bpmMin=129')).toEqual(['D']);
    expect(await get('user=two')).toEqual(['E', 'D', 'C']);
    expect(await get('user=two&tag=house&bpmMin=100')).toEqual(['C']);
    expect(await get('q=floor')).toEqual(['A']);
    expect(await get('q=dnb')).toEqual(['D']);
    // wildcards in the search text are literal
    expect(await get('q=100%25')).toEqual(['E']);
    expect(await get('q=chill_')).toEqual(['E']);
    expect(await get('q=%25')).toEqual(['E']);
    expect(await get('q=_')).toEqual(['E']);
    expect(await get('tag=nothing')).toEqual([]);
    expect((await g.call('GET', '/api/beats?bpmMin=abc')).status).toBe(400);
  });

  it('pages through every sort with cursors, without gaps or repeats', async () => {
    for (const sort of ['new', 'top', 'plays']) {
      const all = titles(await g.call('GET', `/api/beats?sort=${sort}`));
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: any = await g.call('GET', `/api/beats?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        expect(page.body.items.length).toBeLessThanOrEqual(2);
        seen.push(...titles(page));
        cursor = page.body.nextCursor;
        pages++;
      } while (cursor);
      expect([sort, seen]).toEqual([sort, all]);
      expect(pages).toBe(3);
    }
    const exact = await g.call('GET', '/api/beats?limit=5');
    expect(exact.body.nextCursor).toBeNull();
    expect((await g.call('GET', '/api/beats?cursor=garbage')).body.error.code).toBe('invalid_cursor');
    // a cursor from one sort is refused by another
    const first = await g.call('GET', '/api/beats?sort=new&limit=1');
    expect((await g.call('GET', `/api/beats?sort=top&cursor=${first.body.nextCursor}`)).status).toBe(400);
    expect((await g.call('GET', '/api/beats?limit=0')).status).toBe(400);
    expect((await g.call('GET', '/api/beats?limit=101')).status).toBe(400);
  });

  it('lists popular tags and public profiles', async () => {
    const tags = await g.call('GET', '/api/tags');
    expect(tags.body.items).toEqual([{ tag: 'house', count: 3 }, { tag: 'lofi', count: 2 }, { tag: 'club', count: 1 }, { tag: 'dnb', count: 1 }]);
    expect((await g.call('GET', '/api/tags?limit=1')).body.items).toEqual([{ tag: 'house', count: 3 }]);
    const two = await g.call('GET', '/api/users/two');
    expect(two.body).toMatchObject({ handle: 'two', beatCount: 3, totalPlays: 3, totalLikes: 2 });
    expect(two.body.joinedAt).toBeTruthy();
  });
});

describe('likes', () => {
  it('likes once per user and unlikes', async () => {
    const beat = await publish(ann, { title: 'Likeable' });
    const url = `/api/beats/${beat.id}/like`;
    expect((await r.call('PUT', url)).status).toBe(401);
    expect((await r.call('PUT', url, { token: bob })).body).toEqual({ likes: 1, likedByMe: true });
    expect((await r.call('PUT', url, { token: bob })).body).toEqual({ likes: 1, likedByMe: true });
    expect((await r.call('PUT', url, { token: ann })).body).toEqual({ likes: 2, likedByMe: true });

    expect((await r.call('GET', `/api/beats/${beat.id}`, { token: bob })).body).toMatchObject({ likes: 2, likedByMe: true });
    expect((await r.call('GET', `/api/beats/${beat.id}`, { token: boss })).body).toMatchObject({ likes: 2, likedByMe: false });
    expect((await r.call('GET', `/api/beats/${beat.id}`)).body.likedByMe).toBe(false);
    const listed = (await r.call('GET', '/api/beats?user=ann', { token: bob })).body.items.find((b: any) => b.id === beat.id);
    expect(listed.likedByMe).toBe(true);

    expect((await r.call('DELETE', url, { token: bob })).body).toEqual({ likes: 1, likedByMe: false });
    expect((await r.call('DELETE', url, { token: bob })).body).toEqual({ likes: 1, likedByMe: false });
    expect((await r.call('PUT', '/api/beats/nope/like', { token: bob })).status).toBe(404);
  });
});

describe('plays', () => {
  it('counts one play per beat per client per hour', async () => {
    const beat = await publish(ann, { title: 'Playable' });
    const other = await publish(ann, { title: 'Playable too' });
    const play = (id: string, ip: string) => r.call('POST', `/api/beats/${id}/play`, { ip });

    expect((await play(beat.id, '203.0.113.5')).body).toEqual({ plays: 1, counted: true });
    expect((await play(beat.id, '203.0.113.5')).body).toEqual({ plays: 1, counted: false });
    expect((await play(beat.id, '203.0.113.6')).body).toEqual({ plays: 2, counted: true });
    // the same client on another beat counts
    expect((await play(other.id, '203.0.113.5')).body).toEqual({ plays: 1, counted: true });

    r.clock.advance(59 * 60_000);
    expect((await play(beat.id, '203.0.113.5')).body).toEqual({ plays: 2, counted: false });
    r.clock.advance(2 * 60_000);
    expect((await play(beat.id, '203.0.113.5')).body).toEqual({ plays: 3, counted: true });
    expect((await play(beat.id, '203.0.113.5')).body).toEqual({ plays: 3, counted: false });
    expect((await r.call('GET', `/api/beats/${beat.id}`)).body.plays).toBe(3);
    expect((await play('nope', '203.0.113.5')).status).toBe(404);
  });

  it('never stores the address itself', async () => {
    const { rows } = await r.db.query('SELECT client_hash FROM beat_plays');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.client_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify((await r.db.query('SELECT * FROM beat_plays')).rows);
    expect(dump).not.toContain('203.0.113');
  });

  it('sweeps play records once they are an hour old', async () => {
    r.clock.advance(61 * 60_000);
    await r.app.loopwell.sweep();
    expect((await r.db.query('SELECT 1 FROM beat_plays')).rows.length).toBe(0);
  });
});

describe('remixes', () => {
  it('credits the parent and the original through a chain', async () => {
    const original = await publish(ann, { title: 'Original' });
    const first = await publish(bob, { title: 'First remix', remixOf: original.id });
    const second = await publish(boss, { title: 'Second remix', remixOf: first.id });
    const credit = { id: original.id, title: 'Original', author: { handle: 'ann', displayName: 'ann', avatarUrl: null } };

    expect(first.remixOf).toEqual(credit);
    expect(first.remixRoot).toEqual(credit);
    expect(second.remixOf).toEqual({ id: first.id, title: 'First remix', author: { handle: 'bob', displayName: 'bob', avatarUrl: null } });
    expect(second.remixRoot).toEqual(credit);

    expect((await r.call('GET', `/api/beats/${original.id}`)).body.remixCount).toBe(1);
    expect(titles(await r.call('GET', `/api/beats/${original.id}/remixes`))).toEqual(['First remix']);
    expect(titles(await r.call('GET', `/api/beats/${first.id}/remixes`))).toEqual(['Second remix']);
    expect(titles(await r.call('GET', `/api/beats/${second.id}/remixes`))).toEqual([]);
    expect((await r.call('GET', '/api/beats/nope/remixes')).status).toBe(404);

    // deleting the middle keeps the credit to the original
    expect((await r.call('DELETE', `/api/beats/${first.id}`, { token: bob })).status).toBe(204);
    const orphan = (await r.call('GET', `/api/beats/${second.id}`)).body;
    expect(orphan.remixOf).toBeNull();
    expect(orphan.remixRoot).toEqual(credit);
    expect((await r.call('GET', `/api/beats/${original.id}`)).body.remixCount).toBe(0);
  });
});

describe('editing and deleting', () => {
  it('lets the author edit, with the same validation as publishing', async () => {
    const beat = await publish(ann, { title: 'Draft title', tags: 'one', bpm: 100, key: 'C', genre: 'house' });
    const url = `/api/beats/${beat.id}`;
    const edited = await r.call('PATCH', url, { token: ann, json: { title: 'Final title', tags: ['Two', 'three'], bpm: null, key: '' } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Final title', tags: ['two', 'three'], bpm: null, key: null, genre: 'house' });
    expect(new Date(edited.body.updatedAt).getTime()).toBeGreaterThan(new Date(beat.updatedAt).getTime());

    expect((await r.call('PATCH', url, { token: ann, json: { bpm: 999 } })).status).toBe(400);
    expect((await r.call('PATCH', url, { token: ann, json: { title: '' } })).status).toBe(400);
    expect((await r.call('PATCH', url, { token: ann, json: { tags: 'a,b,c,d,e,f,g,h,i' } })).status).toBe(400);
  });

  it("refuses to change or delete someone else's beat", async () => {
    const beat = await publish(ann, { title: 'Hands off' });
    const url = `/api/beats/${beat.id}`;
    const patch = await r.call('PATCH', url, { token: bob, json: { title: 'Mine now' } });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('forbidden');
    expect((await r.call('DELETE', url, { token: bob })).status).toBe(403);
    expect((await r.call('PATCH', url, { json: { title: 'x' } })).status).toBe(401);
    expect((await r.call('DELETE', url)).status).toBe(401);
    expect((await r.call('GET', url)).body.title).toBe('Hands off');
  });

  it('lets an admin edit and delete, and logs it', async () => {
    const beat = await publish(ann, { title: 'Moderated' });
    const url = `/api/beats/${beat.id}`;
    expect((await r.call('PATCH', url, { token: boss, json: { title: 'Cleaned up' } })).body.title).toBe('Cleaned up');
    const files = (await r.stored()).length;
    expect((await r.call('DELETE', url, { token: boss })).status).toBe(204);
    expect((await r.call('GET', url)).status).toBe(404);
    expect((await r.stored()).length).toBe(files - 1);
    const audit = await r.call('GET', '/api/admin/audit', { token: boss });
    expect(audit.body.items.slice(0, 2).map((a: any) => [a.admin, a.action, a.targetType, a.targetId])).toEqual([
      ['boss', 'beat.remove', 'beat', beat.id],
      ['boss', 'beat.edit', 'beat', beat.id],
    ]);
  });

  it('counts published beats against the storage quota', async () => {
    const small = await rig({ USER_QUOTA_MB: String(2 / 1024) });
    try {
      const token = await small.login('tiny');
      expect((await small.call('POST', '/api/beats?title=a', { token, bytes: zip(1100) })).status).toBe(201);
      const over = await small.call('POST', '/api/beats?title=b', { token, bytes: zip(1100) });
      expect(over.status).toBe(413);
      expect(over.body.error.code).toBe('quota_exceeded');
      expect((await small.stored()).length).toBe(1);
      expect((await small.call('GET', '/api/beats')).body.items.length).toBe(1);
    } finally {
      await small.close();
    }
  });
});
