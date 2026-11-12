// Live sessions: several people editing one beat. The beat lives in a Yjs
// document, so edits merge without conflicts and survive short disconnects.
// This module is the relay: it keeps each room's copy of the document (so
// late joiners get it), passes updates and presence along, stamps the shared
// transport clock, and enforces what the host decides (locks, read-only,
// kicks). Rooms live in memory only; nothing is written to the database and
// no account is needed.
//
// Wire format. Text frames are JSON messages with a `t` field. Binary frames
// start with one type byte: 1 = a Yjs update to merge, 2 = the room's whole
// state, which replaces the receiver's document (sent after a refused edit).

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';

const UPDATE = 1, REPLACE = 2;
const COLORS = 8;

export interface RealtimeOptions {
  maxPeers?: number;
  /** How long an empty room is kept, for people who dropped and are coming back. */
  idleMs?: number;
  maxUpdateBytes?: number;
  maxDocBytes?: number;
  /** Lead time between a play request and the moment everyone starts. */
  startDelayMs?: number;
  now?: () => number;
}

interface Peer {
  id: string;
  client: string;
  name: string;
  color: number;
  host: boolean;
  ws: WebSocket;
  aw: unknown;
  chatAt: number[];
}

interface Transport { playing: boolean; startAt: number; pattern: number; from: number; song: boolean; by: string }

interface Room {
  id: string;
  doc: Y.Doc;
  peers: Map<string, Peer>;
  hostKey: string;
  locks: Set<string>;
  readOnly: boolean;
  banned: Set<string>;
  chat: { id: string; name: string; color: number; text: string; at: number }[];
  log: { name: string; color: number; what: string; at: number }[];
  transport: Transport;
  emptySince: number;
  seq: number;
}

export interface Realtime {
  rooms: Map<string, Room>;
  /** Drops rooms that have been empty for too long. Called on a timer; exposed for tests. */
  sweep(): void;
  close(): void;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** The tracks a host has locked, as plain data, for comparing before and after an edit. */
function lockedState(doc: Y.Doc, locks: Set<string>): string {
  const tracks = doc.getMap('p').get('tracks');
  if (!(tracks instanceof Y.Array)) return '';
  const out: Record<string, unknown> = {};
  tracks.forEach((t: unknown, i: number) => {
    if (!(t instanceof Y.Map)) return;
    const id = t.get('id') as string;
    if (locks.has(id)) out[id] = [i, t.toJSON()];
  });
  return JSON.stringify(out);
}

export function attachRealtime(app: FastifyInstance, opts: RealtimeOptions = {}): Realtime {
  const maxPeers = opts.maxPeers ?? 12;
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const maxUpdate = opts.maxUpdateBytes ?? 1024 * 1024;
  const maxDoc = opts.maxDocBytes ?? 4 * 1024 * 1024;
  const startDelay = opts.startDelayMs ?? 250;
  const now = opts.now ?? (() => Date.now());
  const origins = app.loopwell.config.appOrigins;
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxUpdate + 64 });

  const send = (p: Peer, m: unknown) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); };
  const sendState = (p: Peer, room: Room, type: number) => {
    const state = Y.encodeStateAsUpdate(room.doc);
    const frame = new Uint8Array(state.length + 1);
    frame[0] = type;
    frame.set(state, 1);
    if (p.ws.readyState === 1) p.ws.send(frame);
  };
  const all = (room: Room, m: unknown, except?: Peer) => { for (const p of room.peers.values()) if (p !== except) send(p, m); };
  const publicPeer = (p: Peer) => ({ id: p.id, name: p.name, color: p.color, host: p.host, aw: p.aw });
  const roomState = (room: Room) => ({ t: 'room', locks: [...room.locks], readOnly: room.readOnly });
  const canEdit = (room: Room, p: Peer) => p.host || !room.readOnly;

  function join(ws: WebSocket, roomId: string, q: URLSearchParams): void {
    const client = text(q.get('client'), 40) || 'anon';
    const key = text(q.get('key'), 80);
    let room = rooms.get(roomId);
    if (!room) {
      if (q.get('create') !== '1' || key.length < 16) return ws.close(4004, 'This session does not exist or has ended.');
      room = {
        id: roomId, doc: new Y.Doc(), peers: new Map(), hostKey: key, locks: new Set(), readOnly: false, banned: new Set(),
        chat: [], log: [], transport: { playing: false, startAt: 0, pattern: 0, from: 0, song: false, by: '' }, emptySince: 0, seq: 0,
      };
      rooms.set(roomId, room);
    }
    if (room.banned.has(client)) return ws.close(4003, 'The host removed you from this session.');
    if (room.peers.size >= maxPeers) return ws.close(4005, 'This session is full.');

    const used = new Set([...room.peers.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color) && color < COLORS - 1) color++;
    const peer: Peer = {
      id: `${(++room.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`, client, color, ws, aw: null, chatAt: [],
      name: text(q.get('name'), 24) || 'guest', host: key.length >= 16 && key === room.hostKey,
    };
    const r = room;
    r.peers.set(peer.id, peer);
    r.emptySince = 0;

    send(peer, {
      t: 'welcome', you: peer.id, host: peer.host, peers: [...r.peers.values()].map(publicPeer), locks: [...r.locks], readOnly: r.readOnly,
      chat: r.chat, log: r.log, transport: r.transport, now: now(),
    });
    sendState(peer, r, UPDATE);
    all(r, { t: 'joined', peer: publicPeer(peer) }, peer);

    ws.on('message', (data: Buffer, binary: boolean) => {
      try {
        if (binary) onUpdate(r, peer, data);
        else onMessage(r, peer, JSON.parse(data.toString('utf8')));
      } catch {
        ws.close(4000, 'That message could not be understood.');
      }
    });
    ws.on('close', () => {
      if (r.peers.get(peer.id) !== peer) return;
      r.peers.delete(peer.id);
      all(r, { t: 'left', id: peer.id });
      if (!r.peers.size) r.emptySince = now();
    });
    ws.on('error', () => ws.terminate());
  }

  function onUpdate(room: Room, peer: Peer, data: Buffer): void {
    if (data[0] !== UPDATE || data.length < 2 || data.length > maxUpdate) return;
    const update = new Uint8Array(data.buffer, data.byteOffset + 1, data.length - 1);
    const refuse = (why: string) => { send(peer, { t: 'denied', why }); sendState(peer, room, REPLACE); };
    if (!canEdit(room, peer)) return refuse('readonly');
    if (room.locks.size && !peer.host) {
      // try the edit on a copy first: once merged, an update can't be taken back out
      const trial = new Y.Doc();
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(room.doc));
      const before = lockedState(trial, room.locks);
      Y.applyUpdate(trial, update);
      const changed = lockedState(trial, room.locks) !== before;
      trial.destroy();
      if (changed) return refuse('locked');
    }
    Y.applyUpdate(room.doc, update);
    if (Y.encodeStateAsUpdate(room.doc).length > maxDoc) return peer.ws.close(4009, 'The session has grown too large.');
    for (const p of room.peers.values()) if (p !== peer && p.ws.readyState === 1) p.ws.send(data);
  }

  function onMessage(room: Room, peer: Peer, m: any): void {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ping':
        return send(peer, { t: 'pong', c: m.c, s: now() });
      case 'aw': {
        const raw = JSON.stringify(m.data ?? null);
        if (raw.length > 400) return;
        peer.aw = JSON.parse(raw);
        return all(room, { t: 'aw', id: peer.id, data: peer.aw }, peer);
      }
      case 'name': {
        const name = text(m.name, 24);
        if (!name) return;
        peer.name = name;
        return all(room, { t: 'joined', peer: publicPeer(peer) });
      }
      case 'chat': {
        const body = text(m.text, 500);
        const t = now();
        peer.chatAt = peer.chatAt.filter((x) => t - x < 5000);
        if (!body || peer.chatAt.length >= 8) return;
        peer.chatAt.push(t);
        const msg = { id: peer.id, name: peer.name, color: peer.color, text: body, at: t };
        room.chat.push(msg);
        if (room.chat.length > 100) room.chat.shift();
        return all(room, { t: 'chat', ...msg });
      }
      case 'did': {
        const what = text(m.what, 120);
        if (!what || !canEdit(room, peer)) return;
        const entry = { name: peer.name, color: peer.color, what, at: now() };
        room.log.push(entry);
        if (room.log.length > 200) room.log.shift();
        return all(room, { t: 'log', ...entry });
      }
      case 'transport': {
        if (!canEdit(room, peer)) return send(peer, { t: 'denied', why: 'readonly' });
        room.transport = {
          playing: !!m.playing, startAt: now() + startDelay, pattern: int(m.pattern, 0, 7, 0), from: int(m.from, 0, 8192, 0), song: !!m.song, by: peer.name,
        };
        return all(room, { t: 'transport', ...room.transport, now: now() });
      }
    }
    // everything below is the host's alone
    if (!peer.host) return;
    switch (m.t) {
      case 'lock': {
        const id = text(m.track, 40);
        if (!id) return;
        if (m.on) room.locks.add(id); else room.locks.delete(id);
        return all(room, roomState(room));
      }
      case 'readonly':
        room.readOnly = !!m.on;
        return all(room, roomState(room));
      case 'kick': {
        const target = room.peers.get(text(m.id, 40));
        if (!target || target.host) return;
        room.banned.add(target.client);
        target.ws.close(4001, 'The host removed you from this session.');
        return;
      }
      case 'end':
        for (const p of room.peers.values()) p.ws.close(4002, 'The host ended the session.');
        rooms.delete(room.id);
        return;
    }
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const match = /^\/api\/live\/([A-Za-z0-9_-]{6,40})$/.exec(url.pathname);
    if (!match) {
      // not ours: leave it to another handler if there is one, otherwise don't leave the socket hanging
      if (url.pathname.startsWith('/api/live') || app.server.listenerCount('upgrade') === 1) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
      return;
    }
    // browsers always send Origin on a WebSocket handshake; only the configured app may connect
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, match[1], url.searchParams));
  };
  app.server.on('upgrade', onUpgrade);

  const sweep = () => {
    const t = now();
    for (const [id, room] of rooms) {
      if (!room.peers.size && room.emptySince && t - room.emptySince > idleMs) { room.doc.destroy(); rooms.delete(id); }
    }
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  const close = () => {
    clearInterval(timer);
    app.server.off('upgrade', onUpgrade);
    for (const room of rooms.values()) for (const p of room.peers.values()) p.ws.terminate();
    rooms.clear();
    wss.close();
  };
  app.server.once('close', close);
  return { rooms, sweep, close };
}
