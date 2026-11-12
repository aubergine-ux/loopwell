import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { attachRealtime, type Realtime } from '../src/realtime.ts';
import { APP_ORIGIN, rig, type Rig } from './helpers.ts';

const KEY = 'host-key-0123456789abcdef';
let r: Rig, rt: Realtime, base: string, clock: number;
const open: Client[] = [];

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  msgs: any[];
  closed: Promise<{ code: number; reason: string }>;
  /** Resolves with the first message of type `t` (already received or yet to come). */
  next(t: string, skip?: number): Promise<any>;
  send(m: unknown): void;
  /** Change the document; the update goes to the room. */
  edit(fn: (root: Y.Map<any>) => void): void;
  tracks(): any[];
}

function connect(room: string, q: Record<string, string> = {}, origin = APP_ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/api/live/${room}?${new URLSearchParams({ name: 'someone', client: `c${open.length}`, ...q })}`, { origin });
    const doc = new Y.Doc();
    const msgs: any[] = [];
    const waiting: { t: string; skip: number; done: (m: any) => void }[] = [];
    const c: Client = {
      ws, doc, msgs,
      closed: new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() }))),
      next: (t, skip = 0) => new Promise((res) => {
        const seen = msgs.filter((m) => m.t === t);
        if (seen.length > skip) res(seen[skip]); else waiting.push({ t, skip: skip - seen.length, done: res });
      }),
      send: (m) => ws.send(JSON.stringify(m)),
      edit: (fn) => doc.transact(() => fn(doc.getMap('p'))),
      tracks: () => (doc.getMap('p').get('tracks') as Y.Array<Y.Map<any>>).toJSON(),
    };
    doc.on('update', (u: Uint8Array, originOf: unknown) => { if (originOf !== 'remote' && ws.readyState === 1) ws.send(Buffer.concat([Buffer.from([1]), u])); });
    const got = (m: any) => {
      msgs.push(m);
      for (const w of [...waiting]) {
        if (w.t !== m.t) continue;
        if (w.skip-- > 0) continue;
        waiting.splice(waiting.indexOf(w), 1);
        w.done(m);
      }
    };
    ws.on('message', (data: Buffer, binary) => {
      if (!binary) return got(JSON.parse(data.toString()));
      if (data[0] === 2) {
        // the room's state replaces ours
        doc.transact(() => { for (const k of [...doc.getMap('p').keys()]) doc.getMap('p').delete(k); }, 'remote');
        Y.applyUpdate(doc, data.subarray(1), 'remote');
        got({ t: 'replaced' });
      } else Y.applyUpdate(doc, data.subarray(1), 'remote');
      got({ t: 'state' });
    });
    ws.on('open', () => { open.push(c); resolve(c); });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

/** A document with two tracks, the way the app lays one out. */
function seed(c: Client): void {
  c.edit((root) => {
    root.set('bpm', 120);
    const tracks = new Y.Array<Y.Map<any>>();
    root.set('tracks', tracks);
    for (const id of ['kick', 'bass']) {
      const t = new Y.Map<any>();
      t.set('id', id); t.set('vol', 100);
      const steps = new Y.Map<number>();
      t.set('steps', steps);
      tracks.push([t]);
    }
  });
}
const track = (c: Client, i: number) => (c.doc.getMap('p').get('tracks') as Y.Array<Y.Map<any>>).get(i);
const settle = () => new Promise((res) => setTimeout(res, 60));

beforeEach(async () => {
  r = await rig();
  clock = 1_000_000;
  rt = attachRealtime(r.app, { maxPeers: 3, idleMs: 1000, startDelayMs: 200, maxUpdateBytes: 20_000, maxDocBytes: 60_000, now: () => clock });
  await r.app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(r.app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const c of open.splice(0)) c.ws.terminate();
  await r.close();
});

describe('live sessions', () => {
  it('needs a host to create a room, and gives a late joiner the whole beat', async () => {
    const stranger = await connect('room-one');
    expect(await stranger.closed).toMatchObject({ code: 4004 });
    await expect(connect('room-one', { create: '1', key: 'short' }).then((c) => c.closed)).resolves.toMatchObject({ code: 4004 });

    const host = await connect('room-one', { create: '1', key: KEY, name: 'Ada' });
    const hello = await host.next('welcome');
    expect(hello).toMatchObject({ host: true, readOnly: false, locks: [], chat: [], log: [] });
    expect(hello.peers).toEqual([{ id: hello.you, name: 'Ada', color: 0, host: true, aw: null }]);
    seed(host);
    await settle();

    const guest = await connect('room-one', { name: 'Bob' });
    const hi = await guest.next('welcome');
    expect(hi.host).toBe(false);
    expect(hi.peers.map((p: any) => [p.name, p.color, p.host])).toEqual([['Ada', 0, true], ['Bob', 1, false]]);
    await guest.next('state');
    expect(guest.tracks().map((t) => t.id)).toEqual(['kick', 'bass']);
    expect((await host.next('joined')).peer.name).toBe('Bob');
  });

  it('merges edits from both sides, including ones made at the same moment', async () => {
    const host = await connect('room-two', { create: '1', key: KEY });
    seed(host);
    await settle();
    const guest = await connect('room-two');
    await guest.next('state');
    // both change different things without having seen the other's change
    host.edit(() => track(host, 0).get('steps').set('4', 100));
    guest.edit(() => track(guest, 1).get('steps').set('7', 90));
    guest.edit((root) => root.set('bpm', 133));
    await settle();
    for (const c of [host, guest]) {
      expect(c.tracks()[0].steps).toEqual({ 4: 100 });
      expect(c.tracks()[1].steps).toEqual({ 7: 90 });
      expect(c.doc.getMap('p').get('bpm')).toBe(133);
    }
    // the same knob at once: both end up with the same value, whichever it is
    host.edit(() => track(host, 0).set('vol', 10));
    guest.edit(() => track(guest, 0).set('vol', 90));
    await settle();
    expect(host.tracks()[0].vol).toBe(guest.tracks()[0].vol);
    expect(rt.rooms.get('room-two')!.doc.getMap('p').get('bpm')).toBe(133);
  });

  it('picks up edits made while someone was disconnected', async () => {
    const host = await connect('room-three', { create: '1', key: KEY });
    seed(host);
    await settle();
    const guest = await connect('room-three', { client: 'bob' });
    await guest.next('state');
    guest.ws.close();
    await guest.closed;
    // both keep working while apart
    guest.doc.transact(() => track(guest, 1).get('steps').set('2', 80));
    host.edit(() => track(host, 0).get('steps').set('0', 127));
    await settle();
    const back = await connect('room-three', { client: 'bob' });
    await back.next('welcome');
    // the app reconnects with the document it kept, and sends all of it
    Y.applyUpdate(back.doc, Y.encodeStateAsUpdate(guest.doc), 'remote');
    back.ws.send(Buffer.concat([Buffer.from([1]), Y.encodeStateAsUpdate(back.doc)]));
    await back.next('state');
    await settle();
    expect(host.tracks()[1].steps).toEqual({ 2: 80 });
    expect(back.tracks()[0].steps).toEqual({ 0: 127 });
    expect(back.tracks()[1].steps).toEqual({ 2: 80 });
  });

  it('relays presence, chat and the activity log, and keeps them for newcomers', async () => {
    const host = await connect('room-four', { create: '1', key: KEY, name: 'Ada' });
    const guest = await connect('room-four', { name: 'Bob' });
    const hello = await guest.next('welcome');
    guest.send({ t: 'aw', data: { x: 0.25, y: 0.5, song: false, pat: 1, sel: 3 } });
    expect(await host.next('aw')).toEqual({ t: 'aw', id: hello.you, data: { x: 0.25, y: 0.5, song: false, pat: 1, sel: 3 } });
    guest.send({ t: 'aw', data: { junk: 'x'.repeat(1000) } }); // too big: dropped
    guest.send({ t: 'chat', text: '  hello\nthere  ' });
    expect(await host.next('chat')).toMatchObject({ name: 'Bob', color: 1, text: 'hello there', at: clock });
    expect((await guest.next('chat')).text).toBe('hello there'); // the sender gets it back too
    guest.send({ t: 'did', what: 'KICK: pattern A' });
    expect(await host.next('log')).toMatchObject({ name: 'Bob', what: 'KICK: pattern A' });
    for (let i = 0; i < 20; i++) guest.send({ t: 'chat', text: `spam ${i}` });
    guest.send({ t: 'chat', text: '' });
    await settle();
    expect(host.msgs.filter((m) => m.t === 'chat').length).toBe(8); // rate limited

    const late = await connect('room-four', { name: 'Cy' });
    const hi = await late.next('welcome');
    expect(hi.chat.length).toBe(8);
    expect(hi.chat[0].text).toBe('hello there');
    expect(hi.log).toEqual([{ name: 'Bob', color: 1, what: 'KICK: pattern A', at: clock }]);
    expect(hi.peers.find((p: any) => p.name === 'Bob').aw).toEqual({ x: 0.25, y: 0.5, song: false, pat: 1, sel: 3 });
    late.ws.close();
    expect((await host.next('left')).id).toBe(hi.you);
  });

  it('starts everyone at the same moment and tells latecomers what is playing', async () => {
    const host = await connect('room-five', { create: '1', key: KEY });
    const guest = await connect('room-five');
    await guest.next('welcome');
    guest.send({ t: 'ping', c: 42 });
    expect(await guest.next('pong')).toEqual({ t: 'pong', c: 42, s: clock });
    guest.send({ t: 'transport', playing: true, pattern: 2, from: 16, song: true });
    const a = await host.next('transport'), b = await guest.next('transport');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ playing: true, startAt: clock + 200, pattern: 2, from: 16, song: true, now: clock });
    clock += 5000;
    const late = await connect('room-five');
    expect((await late.next('welcome')).transport).toMatchObject({ playing: true, startAt: clock - 5000 + 200, from: 16 });
    host.send({ t: 'transport', playing: false });
    expect((await late.next('transport')).playing).toBe(false);
  });

  it('lets only the host lock tracks, and refuses edits to a locked track', async () => {
    const host = await connect('room-six', { create: '1', key: KEY });
    seed(host);
    await settle();
    const guest = await connect('room-six');
    await guest.next('state');
    guest.send({ t: 'lock', track: 'bass', on: true }); // not the host: ignored
    host.send({ t: 'lock', track: 'kick', on: true });
    expect(await guest.next('room')).toEqual({ t: 'room', locks: ['kick'], readOnly: false });

    guest.edit(() => track(guest, 0).get('steps').set('3', 99));
    expect(await guest.next('denied')).toEqual({ t: 'denied', why: 'locked' });
    await guest.next('replaced');
    expect(host.tracks()[0].steps).toEqual({});
    // the other track is still fair game, and the host can edit the locked one
    const fresh = await connect('room-six', { client: 'again' });
    await fresh.next('state');
    fresh.edit(() => track(fresh, 1).set('vol', 55));
    host.edit(() => track(host, 0).set('vol', 77));
    await settle();
    expect(host.tracks()[1].vol).toBe(55);
    expect(fresh.tracks()[0].vol).toBe(77);
    // deleting a locked track is an edit to it too
    fresh.edit((root) => (root.get('tracks') as Y.Array<any>).delete(0, 1));
    expect((await fresh.next('denied')).why).toBe('locked');
    expect(host.tracks().length).toBe(2);
    host.send({ t: 'lock', track: 'kick', on: false });
    await host.next('room', 1);
    guest.ws.close();
    await guest.closed;
    const third = await connect('room-six', { client: 'third' });
    await third.next('state');
    third.edit(() => track(third, 0).get('steps').set('3', 99));
    await settle();
    expect(host.tracks()[0].steps).toEqual({ 3: 99 });
  });

  it('makes guests viewers in a view-only session', async () => {
    const host = await connect('room-seven', { create: '1', key: KEY });
    seed(host);
    await settle();
    const guest = await connect('room-seven');
    await guest.next('state');
    host.send({ t: 'readonly', on: true });
    expect((await guest.next('room')).readOnly).toBe(true);
    guest.edit((root) => root.set('bpm', 200));
    expect((await guest.next('denied')).why).toBe('readonly');
    guest.send({ t: 'transport', playing: true });
    guest.send({ t: 'did', what: 'tempo' });
    expect((await guest.next('denied', 1)).why).toBe('readonly');
    await settle();
    expect(host.doc.getMap('p').get('bpm')).toBe(120);
    expect(host.msgs.some((m) => m.t === 'transport' || m.t === 'log')).toBe(false);
    guest.send({ t: 'chat', text: 'nice' }); // viewers can still talk
    expect((await host.next('chat')).text).toBe('nice');
    host.edit((root) => root.set('bpm', 99));
    await settle();
    expect(rt.rooms.get('room-seven')!.doc.getMap('p').get('bpm')).toBe(99);
    expect((await connect('room-seven', { client: 'x' }).then((c) => c.next('welcome'))).readOnly).toBe(true);
  });

  it('lets the host remove someone, who then cannot come back', async () => {
    const host = await connect('room-eight', { create: '1', key: KEY });
    const guest = await connect('room-eight', { client: 'troll' });
    const hello = await guest.next('welcome');
    guest.send({ t: 'kick', id: (await host.next('welcome')).you }); // guests can't kick
    await settle();
    expect(host.ws.readyState).toBe(1);
    host.send({ t: 'kick', id: hello.you });
    expect(await guest.closed).toMatchObject({ code: 4001 });
    expect((await host.next('left')).id).toBe(hello.you);
    expect(await (await connect('room-eight', { client: 'troll' })).closed).toMatchObject({ code: 4003 });
    expect((await (await connect('room-eight', { client: 'someone-else' })).next('welcome')).host).toBe(false);
  });

  it('gives the host their seat back, limits the room, and ends on request', async () => {
    const host = await connect('room-nine', { create: '1', key: KEY });
    host.ws.close();
    await host.closed;
    const again = await connect('room-nine', { key: KEY });
    expect((await again.next('welcome')).host).toBe(true);
    expect((await (await connect('room-nine', { key: 'wrong-key-0123456789' })).next('welcome')).host).toBe(false);
    await connect('room-nine');
    expect(await (await connect('room-nine')).closed).toMatchObject({ code: 4005 }); // three is the limit here
    again.send({ t: 'end' });
    expect(await again.closed).toMatchObject({ code: 4002 });
    expect(rt.rooms.has('room-nine')).toBe(false);
  });

  it('forgets an empty room after a while, and not before', async () => {
    const host = await connect('room-ten', { create: '1', key: KEY });
    host.ws.close();
    await host.closed;
    await settle();
    clock += 500;
    rt.sweep();
    expect(rt.rooms.has('room-ten')).toBe(true);
    clock += 1000;
    rt.sweep();
    expect(rt.rooms.has('room-ten')).toBe(false);
  });

  it('turns away other websites, junk and oversized documents', async () => {
    await expect(connect('room-evil', { create: '1', key: KEY }, 'https://evil.example')).rejects.toThrow(/403/);
    const host = await connect('room-junk', { create: '1', key: KEY });
    host.ws.send('this is not json');
    expect(await host.closed).toMatchObject({ code: 4000 });
    const big = await connect('room-big', { create: '1', key: KEY });
    for (let i = 0; i < 8; i++) big.edit((root) => root.set(`blob${i}`, 'x'.repeat(10_000)));
    expect(await big.closed).toMatchObject({ code: 4009 });
    await expect(connect('../etc/passwd')).rejects.toThrow();
  });
});
