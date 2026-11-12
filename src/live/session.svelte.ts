// A live session: several people on one beat. The beat is mirrored into a Yjs
// document (see ydoc.ts); the server relays updates, presence, chat and the
// shared transport clock, and enforces the host's decisions.

import * as Y from 'yjs';
import { fixSelection, hooks, startPlaying, stopPlaying, toast } from '../actions.svelte';
import { audio } from '../audio/host';
import { serverUrl } from '../community/api';
import { stepToSeconds } from '../core/arrange';
import { newId, sanitize, type Project } from '../core/types';
import { app } from '../state.svelte';
import { describeChange, fromY, patchInto, same, toY } from './ydoc';

/** Where someone's pointer is: fractions of the upper (zone 0) or lower (zone 1) part of the instrument, and what they have open. */
export interface Presence { x: number; y: number; zone: number; tab: string; song: boolean; pat: number; sel: number }
export interface Peer { id: string; name: string; color: number; host: boolean; aw: Presence | null }
export interface ChatMsg { id: string; name: string; color: number; text: string; at: number }
export interface LogEntry { name: string; color: number; what: string; at: number }

export const live = $state({
  on: false,
  /** Connected right now. False while reconnecting after a dropout; edits are kept and merged when it comes back. */
  online: false,
  room: '',
  me: '',
  host: false,
  readOnly: false,
  peers: [] as Peer[],
  /** Ids of the tracks the host has locked, and the ids of all tracks in order. */
  locks: [] as string[],
  trackIds: [] as string[],
  chat: [] as ChatMsg[],
  log: [] as LogEntry[],
  unread: 0,
  /** Room named in an invite link, waiting for a name before joining. */
  invite: '',
});

const UPDATE = 1, REPLACE = 2;
const NAME_KEY = 'loopwell:name', CLIENT_KEY = 'loopwell:client';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const random = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

let doc = new Y.Doc();
let ws: WebSocket | null = null;
let synced: Project | null = null; // the beat as the document last had it
let creating = false;
let gotState = false;
let retries = 0;
let retryTimer = 0, pingTimer = 0, startTimer = 0, logTimer = 0, awTimer = 0;
let clockOffset = 0; // server clock minus ours, in ms
let bestRtt = Infinity;
let pendingLog: string[] = [];
let lastAw = '';
let latestAw: Presence | null = null;

export const savedName = () => store.get(NAME_KEY);
export const canEdit = () => !live.on || live.host || !live.readOnly;
export const isLocked = (track: number) => live.on && live.locks.includes(live.trackIds[track]);
export const inviteLink = () => `${location.origin}${location.pathname}#live=${live.room}&server=${encodeURIComponent(serverUrl())}`;
const snapshot = () => $state.snapshot(app.project) as Project;

function clientId(): string {
  let id = store.get(CLIENT_KEY);
  if (!id) { id = random(16); store.set(CLIENT_KEY, id); }
  return id;
}

function sendJson(m: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function sendUpdate(update: Uint8Array): void {
  if (ws?.readyState !== WebSocket.OPEN) return; // offline: the document keeps it, and reconnecting sends everything
  const frame = new Uint8Array(update.length + 1);
  frame[0] = UPDATE;
  frame.set(update, 1);
  ws.send(frame);
}

function watch(d: Y.Doc): void {
  d.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') sendUpdate(update); });
}

/** Everything about one track that a lock protects, for comparing before and after. */
function trackState(p: Project, i: number): unknown {
  return [p.tracks[i], p.patterns.map((pat) => [pat.steps[i], pat.notes[i]]),
    p.arr.clips.filter((c) => c.track === i).map((c) => [c.pattern, c.start, c.len, c.offset]).sort(),
    p.arr.lanes.filter((l) => l.track === i).map((l) => [l.param, l.on, l.points])];
}

/** Clips and lanes compared by what they are, not by their ids or the order they are stored in. */
function sameArrangement(a: Project, b: Project): boolean {
  const flat = (p: Project) => ({
    ...p.arr,
    clips: p.arr.clips.map((c) => `${c.track},${c.start},${c.len},${c.pattern},${c.offset}`).sort(),
    lanes: p.arr.lanes.map((l) => JSON.stringify([l.track, l.param, l.on, l.points])).sort(),
  });
  return same(flat(a), flat(b));
}

let warned = 0, warnedWith = '';
function refuse(msg: string): false {
  // dragging a locked knob would otherwise fire this many times a second
  if (msg !== warnedWith || Date.now() - warned > 2500) { warned = Date.now(); warnedWith = msg; toast(msg, 'error'); }
  pull();
  return false;
}

/** Every local edit passes through here on its way to the audio engine. */
function onLocalChange(snap: Project): boolean {
  if (!live.on || !gotState) return true;
  const before = synced;
  // the view someone is in is their own business, not an edit
  if (before && same({ ...snap, songMode: false, arr: null }, { ...before, songMode: false, arr: null }) && sameArrangement(before, snap)) return true;
  if (!canEdit()) return refuse('The host has made this session view-only.');
  if (!live.host && before) {
    for (const id of live.locks) {
      const was = idsAtSync.indexOf(id), now = live.trackIds.indexOf(id);
      if (was < 0) continue;
      if (now < 0 || !same(trackState(before, was), trackState(snap, now))) return refuse(`${before.tracks[was].name} is locked by the host.`);
    }
  }
  // a whole new beat was loaded: its tracks are new tracks
  if (live.trackIds.length !== snap.tracks.length) live.trackIds = snap.tracks.map(() => newId());
  toY(doc, snap, live.trackIds);
  if (before) {
    const what = describeChange(before, snap);
    if (what) {
      // a burst of edits becomes one line, without dropping any of them
      for (const part of what.split(', ')) if (!pendingLog.includes(part) && pendingLog.length < 6) pendingLog.push(part);
      clearTimeout(logTimer);
      logTimer = window.setTimeout(flushLog, 900);
    }
    if (before.bpm !== snap.bpm && app.playing) reanchor();
  }
  synced = snap;
  idsAtSync = [...live.trackIds];
  return true;
}

let idsAtSync: string[] = []; // track ids as they were when `synced` was taken

function flushLog(): void {
  if (pendingLog.length) sendJson({ t: 'did', what: pendingLog.join(', ') });
  pendingLog = [];
}

/** Bring the app in line with the document (after someone else's edit, or to undo a refused one). */
function pull(): void {
  const r = fromY(doc);
  if (!r) return;
  const project = sanitize(r.project);
  project.songMode = app.project.songMode;
  live.trackIds = r.trackIds.slice(0, project.tracks.length);
  idsAtSync = [...live.trackIds];
  synced = JSON.parse(JSON.stringify(project));
  patchInto(app.project, project);
  fixSelection();
}

function onRemote(data: Uint8Array): void {
  const type = data[0], body = data.subarray(1);
  if (type === REPLACE) {
    // an edit of ours was refused: drop our copy and take the room's
    doc.destroy();
    doc = new Y.Doc();
    watch(doc);
    Y.applyUpdate(doc, body, 'remote');
    pull();
    return;
  }
  if (type !== UPDATE) return;
  // anything edited here that hasn't been written to the document yet goes in first, so it isn't overwritten
  if (gotState && synced && canEdit()) onLocalChange(snapshot());
  Y.applyUpdate(doc, body, 'remote');
  if (!gotState) {
    gotState = true;
    if (creating) { synced = snapshot(); idsAtSync = [...live.trackIds]; return; }
    if (!fromY(doc)) { leave('That session has nothing in it yet.'); return; }
    stopPlaying();
  }
  pull();
}

// --- shared transport ---

const serverNow = () => Date.now() + clockOffset;

/** Steps the beat has moved on after `ms` of playing from `from`. */
function stepsAfter(p: Project, from: number, ms: number, song: boolean): number {
  if (!song) return Math.floor(ms / (15000 / p.bpm));
  let n = 0;
  const start = stepToSeconds(p, from) * 1000;
  while (n < 100000 && stepToSeconds(p, from + n + 1) * 1000 - start <= ms) n++;
  return n;
}

function onTransport(m: { playing: boolean; startAt: number; pattern: number; from: number; song: boolean; by?: string }): void {
  clearTimeout(startTimer);
  if (!m.playing) { stopPlaying(); return; }
  const p = app.project;
  const begin = () => {
    if (!live.on) return;
    p.songMode = m.song;
    app.pat = m.pattern;
    const late = serverNow() - m.startAt;
    if (late <= 30) { startPlaying(m.pattern, m.from); return; }
    // already under way: come in on the next step, at the place everyone else has reached
    const done = stepsAfter(p, m.from, late, m.song) + 1;
    const at = m.song ? (stepToSeconds(p, m.from + done) - stepToSeconds(p, m.from)) * 1000 : done * (15000 / p.bpm);
    startTimer = window.setTimeout(() => {
      if (m.song) startPlaying(m.pattern, m.from + done);
      else startPlaying(m.pattern, 0, (m.from + done) % p.steps);
    }, Math.max(0, at - late));
  };
  const wait = m.startAt - serverNow();
  if (wait > 0) startTimer = window.setTimeout(begin, wait); else begin();
}

function sendTransport(playing: boolean, from = app.project.songMode ? app.cursor : 0): void {
  sendJson({ t: 'transport', playing, pattern: app.pat, from, song: app.project.songMode });
}

/** After a tempo change, start everyone again from where the music is, so they stay together. */
function reanchor(): void {
  const head = audio.playhead();
  if (!head) return;
  const ahead = Math.ceil(300 / (15000 / app.project.bpm)) + 1;
  sendTransport(true, (head.song >= 0 ? head.song : head.step) + ahead);
}

function ping(): void {
  sendJson({ t: 'ping', c: Date.now() });
}

// --- connection ---

function onMessage(m: any): void {
  switch (m.t) {
    case 'welcome':
      live.me = m.you; live.host = m.host; live.peers = m.peers; live.locks = m.locks; live.readOnly = m.readOnly;
      live.chat = m.chat; live.log = m.log;
      clockOffset = m.now - Date.now();
      live.online = true;
      retries = 0;
      bestRtt = Infinity;
      ping();
      // whatever we have (the beat we are sharing, or edits made while offline) goes to the room
      sendUpdate(Y.encodeStateAsUpdate(doc));
      if (m.transport?.playing && !creating) onTransport(m.transport);
      break;
    case 'pong': {
      const rtt = Date.now() - m.c;
      if (rtt < bestRtt) { bestRtt = rtt; clockOffset = m.s - (m.c + rtt / 2); }
      break;
    }
    case 'joined': {
      const i = live.peers.findIndex((p) => p.id === m.peer.id);
      if (i >= 0) live.peers[i] = m.peer; else { live.peers.push(m.peer); live.log.push({ name: m.peer.name, color: m.peer.color, what: 'joined', at: Date.now() }); }
      break;
    }
    case 'left': {
      const gone = live.peers.find((p) => p.id === m.id);
      if (gone) live.log.push({ name: gone.name, color: gone.color, what: 'left', at: Date.now() });
      live.peers = live.peers.filter((p) => p.id !== m.id);
      break;
    }
    case 'aw': {
      const peer = live.peers.find((p) => p.id === m.id);
      if (peer) peer.aw = m.data;
      break;
    }
    case 'room':
      live.locks = m.locks; live.readOnly = m.readOnly;
      break;
    case 'chat':
      live.chat.push(m);
      if (live.chat.length > 100) live.chat.shift();
      if (app.tab !== 'live' && m.id !== live.me) live.unread++;
      break;
    case 'log':
      live.log.push(m);
      if (live.log.length > 200) live.log.shift();
      break;
    case 'transport':
      onTransport(m);
      break;
    case 'denied':
      toast(m.why === 'locked' ? 'That track is locked by the host.' : 'The host has made this session view-only.', 'error');
      break;
  }
}

function connect(name: string): void {
  const base = serverUrl().replace(/^http/, 'ws');
  const q = new URLSearchParams({ name, client: clientId() });
  const key = store.get(`loopwell:live:${live.room}`);
  if (key) q.set('key', key);
  if (creating && !gotState) q.set('create', '1');
  const sock = new WebSocket(`${base}/api/live/${live.room}?${q}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    if (typeof e.data === 'string') onMessage(JSON.parse(e.data));
    else onRemote(new Uint8Array(e.data as ArrayBuffer));
  };
  sock.onclose = (e) => {
    if (ws !== sock || !live.on) return;
    live.online = false;
    // 4000-4999 are the server telling us why; anything else is the network
    if (e.code >= 4000 && e.code < 5000) { leave(e.reason || 'The session ended.'); return; }
    if (retries >= 12) { leave(gotState ? 'Lost the connection to the session.' : 'Could not reach the session.'); return; }
    retryTimer = window.setTimeout(() => connect(name), Math.min(8000, 500 * 2 ** retries++));
  };
}

function begin(room: string, name: string, create: boolean): void {
  if (live.on) leave();
  if (!serverUrl()) { toast('Live sessions need a Loopwell server. Connect to one under Community.', 'error'); return; }
  name = name.trim().slice(0, 24) || 'guest';
  store.set(NAME_KEY, name);
  doc = new Y.Doc();
  watch(doc);
  creating = create;
  gotState = false;
  synced = null;
  retries = 0;
  Object.assign(live, { on: true, online: false, room, me: '', host: create, readOnly: false, peers: [], locks: [], chat: [], log: [], unread: 0, invite: '' });
  if (create) {
    live.trackIds = app.project.tracks.map(() => newId());
    toY(doc, snapshot(), live.trackIds, 'remote'); // not sent yet: the whole state goes once the room says hello
  }
  hooks.changed = onLocalChange;
  hooks.transport = (playing) => {
    if (!canEdit() || !live.online) return false; // viewers and the disconnected just play for themselves
    sendTransport(playing);
    return true;
  };
  hooks.tracks = (added, i) => { if (added) live.trackIds.splice(i, 0, newId()); else live.trackIds.splice(i, 1); };
  hooks.noHistory = true;
  pingTimer = window.setInterval(ping, 15000);
  connect(name);
}

/** Share the beat on screen. Whoever starts the session is its host. */
export function startSession(name: string): void {
  const room = random(10);
  store.set(`loopwell:live:${room}`, random(32));
  begin(room, name, true);
}

/** Join someone's session. Their beat replaces the one on screen (which stays in undo once you leave). */
export function joinSession(room: string, name: string): void {
  begin(room, name, false);
}

export function leave(why = ''): void {
  if (!live.on) return;
  flushLog();
  live.on = false;
  live.online = false;
  for (const t of [retryTimer, startTimer, logTimer, awTimer]) clearTimeout(t);
  clearInterval(pingTimer);
  const sock = ws;
  ws = null;
  sock?.close(1000);
  hooks.changed = hooks.transport = hooks.tracks = null;
  hooks.noHistory = false;
  doc.destroy();
  if (app.tab === 'live') app.tab = 'sound';
  if (why) toast(why, 'error');
}

// --- things people do in a session ---

export function sendChat(text: string): void {
  if (text.trim()) sendJson({ t: 'chat', text: text.trim() });
}

/** Tell the others where our pointer is and what we are looking at (sent at most ~15 times a second). */
export function setPresence(p: Presence | null): void {
  latestAw = p;
  if (awTimer) return; // the newest position goes out when the timer fires
  const flush = () => {
    const raw = JSON.stringify(latestAw);
    awTimer = 0;
    if (!live.online || raw === lastAw) return;
    lastAw = raw;
    sendJson({ t: 'aw', data: latestAw });
    awTimer = window.setTimeout(flush, 66);
  };
  flush();
}

export const lockTrack = (track: number, on: boolean) => sendJson({ t: 'lock', track: live.trackIds[track], on });
export const kick = (id: string) => sendJson({ t: 'kick', id });
export const setReadOnly = (on: boolean) => sendJson({ t: 'readonly', on });
export function endSession(): void {
  sendJson({ t: 'end' });
}
