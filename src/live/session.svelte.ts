// A live session: several people on one beat. This is the half the rest of the app talks to: what the session
// looks like right now, and the things people can do in one. The half that does the work (and brings in Yjs, the
// library that merges everyone's edits) is in engine.svelte.ts, and is only fetched when a session starts.

import { serverUrl } from '../community/api';

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

const NAME_KEY = 'loopwell:name';

export const savedName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
export const canEdit = () => !live.on || live.host || !live.readOnly;
export const isLocked = (track: number) => live.on && live.locks.includes(live.trackIds[track]);
export const inviteLink = () => `${location.origin}${location.pathname}#live=${live.room}&server=${encodeURIComponent(serverUrl())}`;

type Engine = typeof import('./engine.svelte');
let engine: Engine | null = null;
const load = async (): Promise<Engine> => (engine ??= await import('./engine.svelte'));

/** Share the beat on screen. Whoever starts the session is its host. */
export function startSession(name: string): void {
  void load().then((e) => e.startSession(name));
}

/** Join someone's session. Their beat replaces the one on screen (which stays in undo once you leave). */
export function joinSession(room: string, name: string): void {
  void load().then((e) => e.joinSession(room, name));
}

// everything below only means something once a session is on, by which time the engine is here
export const leave = (why = ''): void => engine?.leave(why);
export const sendChat = (text: string): void => engine?.sendChat(text);
/** Tell the others where our pointer is and what we are looking at. */
export const setPresence = (p: Presence | null): void => engine?.setPresence(p);
export const lockTrack = (track: number, on: boolean): void => engine?.lockTrack(track, on);
export const kick = (id: string): void => engine?.kick(id);
export const setReadOnly = (on: boolean): void => engine?.setReadOnly(on);
export const endSession = (): void => engine?.endSession();
