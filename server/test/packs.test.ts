import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanAudio, sniff } from '../src/audio.ts';
import { aiff, flac, m4a, mp3, mp3WithId3, ogg, rig, wav, zip, type Rig } from './helpers.ts';

describe('audio scanning', () => {
  it('recognises each accepted format by its magic bytes', () => {
    expect(sniff(wav())).toBe('wav');
    expect(sniff(aiff())).toBe('aiff');
    expect(sniff(mp3())).toBe('mp3');
    expect(sniff(mp3WithId3())).toBe('mp3');
    expect(sniff(ogg())).toBe('ogg');
    expect(sniff(flac())).toBe('flac');
    expect(sniff(m4a())).toBe('m4a');
  });

  it('rejects everything else', () => {
    const nope = [
      zip(200),
      Buffer.from('<html><body>not audio</body></html>'),
      Buffer.from('MZ' + '\0'.repeat(100), 'latin1'),
      Buffer.alloc(200),
      Buffer.from('RIFF\x10\x00\x00\x00AVI LIST' + '\0'.repeat(50), 'latin1'),
      Buffer.from('\x00\x00\x00\x20ftypqt  ' + '\0'.repeat(50), 'latin1'),
      // an ID3 tag with no audio frame after it
      Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(100)]),
      Buffer.from('RIFF'),
    ];
    for (const b of nope) {
      expect(sniff(b)).toBeNull();
      expect(() => scanAudio(b, 60)).toThrowError(expect.objectContaining({ status: 415, code: 'unsupported_audio' }));
    }
  });

  it('reads duration, channels and rate from WAV, AIFF and FLAC headers', () => {
    expect(scanAudio(wav({ seconds: 1.5, channels: 2, sampleRate: 44100, bits: 16 }), 60)).toEqual({ format: 'wav', durationMs: 1500, channels: 2, sampleRate: 44100 });
    expect(scanAudio(aiff({ seconds: 2, channels: 1, sampleRate: 48000 }), 60)).toEqual({ format: 'aiff', durationMs: 2000, channels: 1, sampleRate: 48000 });
    expect(scanAudio(aiff({ seconds: 0.5, sampleRate: 22050 }), 60)).toMatchObject({ durationMs: 500, sampleRate: 22050 });
    expect(scanAudio(flac({ seconds: 3, channels: 2, sampleRate: 96000 }), 60)).toEqual({ format: 'flac', durationMs: 3000, channels: 2, sampleRate: 96000 });
    expect(scanAudio(mp3(), 60)).toEqual({ format: 'mp3', durationMs: null, channels: null, sampleRate: null });
  });

  it('enforces the duration limit', () => {
    const tooLong = expect.objectContaining({ status: 422, code: 'audio_too_long' });
    expect(() => scanAudio(wav({ seconds: 61 }), 60)).toThrowError(tooLong);
    expect(scanAudio(wav({ seconds: 60 }), 60).durationMs).toBe(60000);
    expect(() => scanAudio(aiff({ seconds: 3600 }), 60)).toThrowError(tooLong);
    expect(() => scanAudio(flac({ seconds: 61 }), 60)).toThrowError(tooLong);
    expect(() => scanAudio(wav({ seconds: 2 }), 1)).toThrowError(tooLong);
  });

  it('rejects absurd channel counts and sample rates, and broken headers', () => {
    const invalid = expect.objectContaining({ status: 422, code: 'invalid_audio' });
    expect(() => scanAudio(wav({ channels: 0 }), 60)).toThrowError(invalid);
    expect(() => scanAudio(wav({ channels: 64 }), 60)).toThrowError(invalid);
    expect(scanAudio(wav({ channels: 8 }), 60).channels).toBe(8);
    expect(() => scanAudio(wav({ sampleRate: 100 }), 60)).toThrowError(invalid);
    expect(() => scanAudio(wav({ sampleRate: 4_000_000 }), 60)).toThrowError(invalid);
    expect(() => scanAudio(aiff({ channels: 200 }), 60)).toThrowError(invalid);
    expect(() => scanAudio(aiff({ sampleRate: 1_000_000 }), 60)).toThrowError(invalid);
    expect(() => scanAudio(flac({ sampleRate: 1000 }), 60)).toThrowError(invalid);

    // a WAV with its chunks cut away
    const headerOnly = wav().subarray(0, 12);
    expect(() => scanAudio(Buffer.concat([headerOnly, Buffer.alloc(40)]), 60)).toThrowError(invalid);
    const noData = wav().subarray(0, 36);
    expect(() => scanAudio(noData, 60)).toThrowError(invalid);
    const zeroAlign = wav();
    zeroAlign.writeUInt16LE(0, 32);
    expect(() => scanAudio(zeroAlign, 60)).toThrowError(invalid);
    const aiffNoComm = Buffer.concat([Buffer.from('FORM\x00\x00\x00\x40AIFFSSND\x00\x00\x00\x08', 'latin1'), Buffer.alloc(40)]);
    expect(() => scanAudio(aiffNoComm, 60)).toThrowError(invalid);
  });

  it('does not trust a WAV data size larger than the file', () => {
    const b = wav({ seconds: 1 });
    b.writeUInt32LE(0xffffffff, 40);
    expect(scanAudio(b, 60).durationMs).toBe(1000);
  });
});

describe('sample packs', () => {
  let r: Rig;
  let ann: string;
  let bob: string;
  let boss: string;

  const newPack = async (token: string, extra: Record<string, unknown> = {}) => {
    const res = await r.call('POST', '/api/packs', { token, json: { name: 'Kit', license: 'CC0-1.0', ...extra } });
    expect(res.status).toBe(201);
    return res.body;
  };
  const upload = (token: string | undefined, packId: string, name: string, bytes: Buffer) =>
    r.call('POST', `/api/packs/${packId}/samples?name=${encodeURIComponent(name)}`, { token, bytes });

  beforeAll(async () => {
    // 64 KB per file, 4 files and 100 KB per pack, 2 s per sample, 150 KB per user
    r = await rig({
      MAX_SAMPLE_MB: String(64 / 1024), MAX_PACK_FILES: '4', MAX_PACK_MB: String(100 / 1024), MAX_SAMPLE_SECONDS: '2', USER_QUOTA_MB: String(150 / 1024),
    });
    ann = await r.login('ann');
    bob = await r.login('bob');
    boss = await r.login('boss');
  });

  afterAll(() => r.close());

  it('creates a draft, takes samples, publishes and serves them', async () => {
    const pack = await newPack(ann, { name: ' Dusty  Drums ', description: 'From an old machine.', license: 'CC-BY-4.0', tags: ['Drums', 'vinyl'] });
    expect(pack).toMatchObject({
      name: 'Dusty Drums', license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'ann',
      tags: ['drums', 'vinyl'], author: { handle: 'ann' }, sampleCount: 0, size: 0, published: false, publishedAt: null, hidden: false, samples: [],
    });

    // a draft is invisible to everyone but its owner, and cannot be published empty
    expect((await r.call('GET', `/api/packs/${pack.id}`)).status).toBe(404);
    expect((await r.call('GET', `/api/packs/${pack.id}`, { token: bob })).status).toBe(404);
    expect((await r.call('GET', `/api/packs/${pack.id}`, { token: ann })).status).toBe(200);
    expect((await r.call('POST', `/api/packs/${pack.id}/publish`, { token: ann })).body.error.code).toBe('empty_pack');

    const kick = wav({ seconds: 0.5, channels: 1, sampleRate: 8000 });
    const up = await upload(ann, pack.id, 'C:\\samples\\Kick 01.wav', kick);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: 'Kick 01.wav', format: 'wav', mime: 'audio/wav', size: kick.length, durationMs: 500, channels: 1, sampleRate: 8000 });
    const snare = await upload(ann, pack.id, 'snare.mp3', mp3());
    expect(snare.body).toMatchObject({ format: 'mp3', mime: 'audio/mpeg', durationMs: null });
    for (const [name, bytes, format] of [['a.aiff', aiff(), 'aiff'], ['b.flac', flac(), 'flac']] as const) {
      expect((await upload(ann, pack.id, name, bytes)).body.format).toBe(format);
    }

    expect((await r.call('GET', '/api/packs')).body.items).toEqual([]);
    expect((await r.call('GET', '/api/packs?mine=1', { token: ann })).body.items.map((p: any) => p.id)).toEqual([pack.id]);
    expect((await r.call('GET', '/api/packs?mine=1')).status).toBe(401);

    const published = await r.call('POST', `/api/packs/${pack.id}/publish`, { token: ann });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ published: true, sampleCount: 4 });
    expect(published.body.samples.map((s: any) => s.name)).toEqual(['Kick 01.wav', 'snare.mp3', 'a.aiff', 'b.flac']);
    const again = await r.call('POST', `/api/packs/${pack.id}/publish`, { token: ann });
    expect(again.body.publishedAt).toBe(published.body.publishedAt);

    const open = await r.call('GET', `/api/packs/${pack.id}`);
    expect(open.status).toBe(200);
    expect(open.body.samples.length).toBe(4);
    const file = await r.call('GET', `/api/packs/${pack.id}/samples/${up.body.id}/data`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.headers['content-disposition']).toBe('attachment; filename="kick-01.wav"');
    expect(file.raw.equals(kick)).toBe(true);
    expect((await r.call('GET', `/api/packs/${pack.id}/samples/nope/data`)).status).toBe(404);

    // removing a sample deletes its file
    const files = (await r.stored()).length;
    expect((await r.call('DELETE', `/api/packs/${pack.id}/samples/${snare.body.id}`, { token: ann })).status).toBe(204);
    expect((await r.call('DELETE', `/api/packs/${pack.id}/samples/${snare.body.id}`, { token: ann })).status).toBe(404);
    expect((await r.stored()).length).toBe(files - 1);
    expect((await r.call('GET', `/api/packs/${pack.id}`)).body.sampleCount).toBe(3);
  });

  it('validates the license and other fields', async () => {
    const post = (json: unknown) => r.call('POST', '/api/packs', { token: ann, json });
    const custom = await post({ name: 'Mine', license: 'custom', licenseUrl: 'https://example.test/license', attribution: 'Studio X' });
    expect(custom.status).toBe(201);
    expect(custom.body).toMatchObject({ license: 'custom', licenseUrl: 'https://example.test/license', attribution: 'Studio X' });
    // a stray licenseUrl is ignored for the standard licenses
    expect((await post({ name: 'Std', license: 'CC-BY-SA-4.0', licenseUrl: 'https://evil.test/' })).body.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0/');

    const bad = [
      { name: 'x', license: 'custom' },
      { name: 'x', license: 'custom', licenseUrl: 'javascript:alert(1)' },
      { name: 'x', license: 'custom', licenseUrl: 'not a url' },
      { name: 'x', license: 'GPL-3.0' },
      { name: 'x' },
      { license: 'CC0-1.0' },
      { name: '', license: 'CC0-1.0' },
      { name: 'x', license: 'CC0-1.0', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
      { name: 'x', license: 'CC0-1.0', tags: [1, 2] },
    ];
    for (const json of bad) {
      const res = await post(json);
      expect([json, res.status, res.body.error.code]).toEqual([json, 400, 'invalid_input']);
    }
    expect((await r.call('POST', '/api/packs', { json: { name: 'x', license: 'CC0-1.0' } })).status).toBe(401);
  });

  it('refuses uploads that are not acceptable audio, with clear errors', async () => {
    const pack = await newPack(ann);
    const before = (await r.stored()).length;
    const cases: [string, Buffer, number, string][] = [
      ['not-audio.wav', zip(500), 415, 'unsupported_audio'],
      ['script.mp3', Buffer.from('<script>alert(1)</script>'.repeat(4)), 415, 'unsupported_audio'],
      ['long.wav', wav({ seconds: 2.5 }), 422, 'audio_too_long'],
      ['long.aiff', aiff({ seconds: 500 }), 422, 'audio_too_long'],
      ['wide.wav', wav({ channels: 32, seconds: 0.1 }), 422, 'invalid_audio'],
      ['fast.wav', wav({ sampleRate: 500_000, seconds: 0.01 }), 422, 'invalid_audio'],
      ['big.wav', wav({ seconds: 1.9, sampleRate: 40000 }), 413, 'payload_too_large'],
    ];
    for (const [name, bytes, status, code] of cases) {
      const res = await upload(ann, pack.id, name, bytes);
      expect([name, res.status, res.body?.error?.code]).toEqual([name, status, code]);
      expect(res.body.error.message.length).toBeGreaterThan(10);
    }
    expect((await upload(ann, pack.id, '', wav())).status).toBe(400);
    expect((await upload(ann, pack.id, 'x'.repeat(81), wav())).status).toBe(400);
    expect((await r.call('POST', `/api/packs/${pack.id}/samples`, { token: ann, bytes: wav() })).status).toBe(400);
    expect((await r.call('POST', `/api/packs/${pack.id}/samples?name=a.wav`, { token: ann, json: {} })).status).toBe(415);
    // nothing was stored for any of them
    expect((await r.stored()).length).toBe(before);
    expect((await r.call('GET', `/api/packs/${pack.id}`, { token: ann })).body.sampleCount).toBe(0);
    await r.call('DELETE', `/api/packs/${pack.id}`, { token: ann });
  });

  it('limits files per pack, bytes per pack and bytes per user', async () => {
    const carol = await r.login('carol');
    const full = await newPack(carol);
    for (let i = 0; i < 4; i++) expect((await upload(carol, full.id, `${i}.wav`, wav({ seconds: 0.1 }))).status).toBe(201);
    const fifth = await upload(carol, full.id, '5.wav', wav({ seconds: 0.1 }));
    expect([fifth.status, fifth.body.error.code]).toEqual([409, 'pack_full']);
    await r.call('DELETE', `/api/packs/${full.id}`, { token: carol });

    // 40 KB samples: two fit in 100 KB, the third does not
    const forty = wav({ seconds: 1, sampleRate: 40000 });
    const heavy = await newPack(carol);
    expect((await upload(carol, heavy.id, 'a.wav', forty)).status).toBe(201);
    expect((await upload(carol, heavy.id, 'b.wav', forty)).status).toBe(201);
    const third = await upload(carol, heavy.id, 'c.wav', forty);
    expect([third.status, third.body.error.code]).toEqual([413, 'pack_too_large']);

    // a second pack takes one more, then the 150 KB account quota stops the next
    const second = await newPack(carol);
    expect((await upload(carol, second.id, 'a.wav', forty)).status).toBe(201);
    const filesBefore = (await r.stored()).length;
    const over = await upload(carol, second.id, 'b.wav', forty);
    expect([over.status, over.body.error.code]).toEqual([413, 'quota_exceeded']);
    expect((await r.stored()).length).toBe(filesBefore);
    expect((await r.call('GET', '/api/me', { token: carol })).body.storage.used).toBe(forty.length * 3);
    expect((await r.call('GET', `/api/packs/${second.id}`, { token: carol })).body).toMatchObject({ sampleCount: 1, size: forty.length });
  });

  it('searches and pages the public list', async () => {
    const dan = await r.login('dan');
    for (const [name, tags] of [['Alpha Keys', ['keys']], ['Beta Bass', ['bass', 'keys']], ['Gamma Hits', ['fx']]] as const) {
      const p = await newPack(dan, { name, tags, description: name === 'Gamma Hits' ? 'one shots and risers' : '' });
      await upload(dan, p.id, 'a.wav', wav({ seconds: 0.05 }));
      await r.call('POST', `/api/packs/${p.id}/publish`, { token: dan });
    }
    const names = async (query: string) => (await r.call('GET', `/api/packs?${query}`)).body.items.map((p: any) => p.name);
    expect(await names('user=dan')).toEqual(['Gamma Hits', 'Beta Bass', 'Alpha Keys']);
    expect(await names('user=dan&tag=keys')).toEqual(['Beta Bass', 'Alpha Keys']);
    expect(await names('q=risers')).toEqual(['Gamma Hits']);
    expect(await names('q=beta')).toEqual(['Beta Bass']);

    const first = await r.call('GET', '/api/packs?user=dan&limit=2');
    expect(first.body.items.map((p: any) => p.name)).toEqual(['Gamma Hits', 'Beta Bass']);
    const rest = await r.call('GET', `/api/packs?user=dan&limit=2&cursor=${first.body.nextCursor}`);
    expect(rest.body.items.map((p: any) => p.name)).toEqual(['Alpha Keys']);
    expect(rest.body.nextCursor).toBeNull();
    expect((await r.call('GET', '/api/packs?cursor=zzz')).status).toBe(400);
  });

  it("keeps other people out of a pack's contents", async () => {
    const pack = await newPack(ann, { name: 'Private kit' });
    const sample = await upload(ann, pack.id, 'a.wav', wav());
    const files = (await r.stored()).length;

    // while it is a draft, others cannot even see it
    expect((await upload(bob, pack.id, 'b.wav', wav())).status).toBe(404);
    expect((await r.call('GET', `/api/packs/${pack.id}/samples/${sample.body.id}/data`, { token: bob })).status).toBe(404);
    expect((await r.call('DELETE', `/api/packs/${pack.id}`, { token: bob })).status).toBe(404);

    await r.call('POST', `/api/packs/${pack.id}/publish`, { token: ann });
    const denied: [string, string, Buffer?][] = [
      ['POST', `/api/packs/${pack.id}/samples?name=b.wav`, wav()],
      ['DELETE', `/api/packs/${pack.id}/samples/${sample.body.id}`],
      ['POST', `/api/packs/${pack.id}/publish`],
      ['DELETE', `/api/packs/${pack.id}`],
    ];
    for (const [method, url, bytes] of denied) {
      const res = await r.call(method, url, { token: bob, bytes });
      expect([method, url, res.status, res.body.error.code]).toEqual([method, url, 403, 'forbidden']);
      expect((await r.call(method, url, { bytes })).status).toBe(401);
    }
    // an admin moderates but does not edit: no uploads, but deletion works and is logged
    expect((await upload(boss, pack.id, 'b.wav', wav())).status).toBe(403);
    expect((await r.stored()).length).toBe(files);
    expect((await r.call('DELETE', `/api/packs/${pack.id}`, { token: boss })).status).toBe(204);
    expect((await r.stored()).length).toBe(files - 1);
    expect((await r.call('GET', `/api/packs/${pack.id}`, { token: ann })).status).toBe(404);
    const audit = await r.call('GET', '/api/admin/audit', { token: boss });
    expect(audit.body.items[0]).toMatchObject({ admin: 'boss', action: 'pack.remove', targetType: 'pack', targetId: pack.id });
  });
});
