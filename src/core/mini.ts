// Live coding: patterns written as text, in the mini-notation that TidalCycles
// and Strudel use. One line per track:
//
//   kick:  x ~ x ~
//   hat:   [x x]*4
//   lead:  <c4 eb4 g4> ~ [c5 g4]/2
//
// A line fills one bar, however many things are in it, so "x x x" is a
// triplet. The text is turned into plain lists of timed hits here, away from
// the audio thread's inner loop; the engine plays the lists on its own clock,
// alongside whatever is on the grid.

import { euclid } from './creative';
import { degreeToPitch, noteName } from './scales';
import { usesNotes, type Project, type TrackKind } from './types';

export const MAX_CODE = 4000;
/** How many different bars a line may run through before it comes round again. */
const MAX_PERIOD = 64;
const MAX_EVENTS = 256;

export class MiniError extends Error {
  constructor(message: string, readonly col: number) { super(message); }
}

type Node =
  | { k: 'word'; v: string; col: number }
  | { k: 'rest' }
  | { k: 'seq'; items: { n: Node; w: number }[] }
  | { k: 'stack'; items: Node[] }
  | { k: 'alt'; items: Node[] }
  | { k: 'choice'; items: Node[]; seed: number }
  | { k: 'fast'; n: Node; by: number }
  | { k: 'euclid'; n: Node; hits: number; steps: number; rot: number }
  | { k: 'maybe'; n: Node; p: number; seed: number };

const WORD = /[A-Za-z0-9#.\-]/;

class Parser {
  private i = 0;
  private seeds = 1;
  constructor(private s: string, private base: number) {}

  private fail(msg: string, at = this.i): never { throw new MiniError(msg, this.base + at); }
  private space(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  private peek(): string { this.space(); return this.s[this.i] ?? ''; }

  private number(what: string): number {
    const m = /^-?\d*\.?\d+/.exec(this.s.slice(this.i));
    if (!m) this.fail(`a number is needed after ${what}`);
    this.i += m[0].length;
    return parseFloat(m[0]);
  }

  parse(): Node {
    const n = this.stack('');
    if (this.peek()) this.fail(`unexpected "${this.peek()}"`);
    return n;
  }

  /** Everything up to `close`: sequences side by side (","), or one picked at random ("|"). */
  private stack(close: string, alt = false): Node {
    const parts: Node[] = [];
    let sep = '';
    for (;;) {
      parts.push(this.seq(alt));
      const c = this.peek();
      if (c === ',' || c === '|') {
        if (sep && sep !== c) this.fail('"," and "|" can\'t be mixed in one group: put one of them in [ ]');
        sep = c;
        this.i++;
        continue;
      }
      if (c !== close) this.fail(close ? `"${close}" is missing` : `unexpected "${c}"`);
      break;
    }
    if (parts.length === 1) return parts[0];
    return sep === '|' ? { k: 'choice', items: parts, seed: this.seeds++ } : { k: 'stack', items: parts };
  }

  /** Things one after another, sharing the time they have between them. Inside < > they take turns, one per bar. */
  private seq(alt: boolean): Node {
    const items: { n: Node; w: number }[] = [];
    for (;;) {
      const c = this.peek();
      if (!c || c === ',' || c === '|' || c === ']' || c === '>') break;
      if (c === '_') {
        // hold the thing before for one more share of the time
        if (!items.length) this.fail('"_" has nothing before it to hold');
        items[items.length - 1].w++;
        this.i++;
        continue;
      }
      if (c === '!') {
        if (!items.length) this.fail('"!" has nothing before it to repeat');
        this.i++;
        items.push({ ...items[items.length - 1] });
        continue;
      }
      const { n, w, copies } = this.step();
      for (let k = 0; k < copies; k++) items.push({ n, w });
      if (items.length > MAX_EVENTS) this.fail('that is more than a bar can hold');
    }
    if (!items.length) return { k: 'rest' };
    if (alt) {
      const turns: Node[] = [];
      for (const it of items) for (let k = 0; k < Math.max(1, Math.round(it.w)); k++) turns.push(it.n);
      return { k: 'alt', items: turns };
    }
    return items.length === 1 && items[0].w === 1 ? items[0].n : { k: 'seq', items };
  }

  private step(): { n: Node; w: number; copies: number } {
    let n = this.atom();
    let w = 1, copies = 1;
    for (;;) {
      const c = this.s[this.i];
      if (c === '*' || c === '/') {
        this.i++;
        const by = this.number(`"${c}"`);
        if (!(by > 0) || by > 64) this.fail('speed has to be between 0 and 64');
        n = { k: 'fast', n, by: c === '*' ? by : 1 / by };
      } else if (c === '@') {
        this.i++;
        w = this.number('"@"');
        if (!(w > 0) || w > 64) this.fail('length has to be between 0 and 64');
      } else if (c === '!' && /\d/.test(this.s[this.i + 1] ?? '')) {
        this.i++;
        copies = Math.round(this.number('"!"'));
        if (copies < 1 || copies > 64) this.fail('repeats have to be between 1 and 64');
      } else if (c === '?') {
        this.i++;
        const p = /[\d.]/.test(this.s[this.i] ?? '') ? this.number('"?"') : 0.5;
        n = { k: 'maybe', n, p: Math.max(0, Math.min(1, p)), seed: this.seeds++ };
      } else if (c === '(') {
        const at = this.i++;
        const a = [this.int()];
        while (this.peek() === ',') { this.i++; a.push(this.int()); }
        if (this.peek() !== ')') this.fail('")" is missing');
        this.i++;
        if (a.length < 2 || a.length > 3) this.fail('it goes (hits,steps) or (hits,steps,turn)', at);
        if (a[1] < 1 || a[1] > 64 || a[0] < 0 || a[0] > a[1]) this.fail('hits can\'t outnumber steps, and 64 steps is the most', at);
        n = { k: 'euclid', n, hits: a[0], steps: a[1], rot: a[2] ?? 0 };
      } else break;
    }
    return { n, w, copies };
  }

  private int(): number {
    this.space();
    return Math.round(this.number('"("'));
  }

  private atom(): Node {
    const c = this.peek();
    const at = this.i;
    if (c === '~') { this.i++; return { k: 'rest' }; }
    if (c === '[') {
      this.i++;
      const n = this.stack(']');
      this.i++;
      return n;
    }
    if (c === '<') {
      this.i++;
      const n = this.stack('>', true);
      this.i++;
      return n;
    }
    if (!WORD.test(c)) this.fail(`unexpected "${c}"`);
    while (this.i < this.s.length && WORD.test(this.s[this.i])) this.i++;
    return { k: 'word', v: this.s.slice(at, this.i), col: this.base + at };
  }
}

interface Ev { b: number; e: number; v: string; col: number }

/** The same "random" number every time for the same place in the same bar, so a render matches what was heard. */
function chance(seed: number, cyc: number, i: number): number {
  let x = (seed * 0x9e3779b1) ^ (cyc * 0x85ebca6b) ^ (i * 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Lay one whole turn of `n` (its turn number `cyc`) into the stretch of time from `b` to `e`. */
function lay(n: Node, cyc: number, b: number, e: number, out: Ev[]): void {
  if (out.length > MAX_EVENTS * 4) return;
  switch (n.k) {
    case 'rest': return;
    case 'word': out.push({ b, e, v: n.v, col: n.col }); return;
    case 'stack': for (const x of n.items) lay(x, cyc, b, e, out); return;
    case 'seq': {
      let total = 0, acc = 0;
      for (const it of n.items) total += it.w;
      for (const it of n.items) {
        lay(it.n, cyc, b + ((e - b) * acc) / total, b + ((e - b) * (acc + it.w)) / total, out);
        acc += it.w;
      }
      return;
    }
    case 'alt': {
      const len = n.items.length;
      lay(n.items[((cyc % len) + len) % len], Math.floor(cyc / len), b, e, out);
      return;
    }
    case 'choice': lay(n.items[Math.floor(chance(n.seed, cyc, 0) * n.items.length)], cyc, b, e, out); return;
    case 'euclid': {
      // the turn is to the left, as Tidal has it: (3,8,2) starts the pattern two steps in
      const hits = euclid(n.steps, n.hits, -n.rot);
      for (let i = 0; i < n.steps; i++) if (hits[i]) lay(n.n, cyc, b + ((e - b) * i) / n.steps, b + ((e - b) * (i + 1)) / n.steps, out);
      return;
    }
    case 'maybe': {
      const tmp: Ev[] = [];
      lay(n.n, cyc, b, e, tmp);
      tmp.forEach((x, i) => { if (chance(n.seed, cyc, i) >= n.p) out.push(x); });
      return;
    }
    case 'fast': {
      // the thing inside runs `by` times as fast: its turns k cover this turn's time from k/by to (k+1)/by
      const f = n.by, span = e - b, eps = 1e-9;
      const first = Math.floor(cyc * f + eps), last = Math.ceil((cyc + 1) * f - eps) - 1;
      for (let k = first; k <= last; k++) {
        const cb = b + span * (k / f - cyc);
        const tmp: Ev[] = [];
        lay(n.n, k, cb, cb + span / f, tmp);
        // only what starts inside this turn belongs to it
        for (const x of tmp) if (x.b >= b - eps && x.b < e - eps) out.push(x);
      }
      return;
    }
  }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => Math.min(MAX_PERIOD, (a * b) / gcd(a, b));

/** After how many bars the pattern is back where it began. */
function period(n: Node): number {
  switch (n.k) {
    case 'word': case 'rest': return 1;
    case 'seq': return n.items.reduce((p, it) => lcm(p, period(it.n)), 1);
    case 'stack': return n.items.reduce((p, x) => lcm(p, period(x)), 1);
    case 'alt': return Math.min(MAX_PERIOD, n.items.length * n.items.reduce((p, x) => lcm(p, period(x)), 1));
    case 'choice': return lcm(16, n.items.reduce((p, x) => lcm(p, period(x)), 1));
    case 'maybe': return lcm(16, period(n.n));
    case 'euclid': return period(n.n);
    case 'fast': {
      if (Number.isInteger(n.by)) return period(n.n);
      // at a speed that isn't a whole number, it lines up with the bar again only after a few of them
      let m = 1;
      while (m < MAX_PERIOD && Math.abs(m * n.by - Math.round(m * n.by)) > 1e-6) m++;
      return Math.min(MAX_PERIOD, m * period(n.n));
    }
  }
}

const NOTE = /^([a-g])([#sb]?)(-?\d)?$/i;
const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export interface CodeTrack { name: string; kind: TrackKind; note: number }

/** What a word means on a kind of track: a pitch and how hard it is hit. Throws for one that means nothing there. */
function meaning(word: string, col: number, tr: CodeTrack, root: number, type: number): { p: number; v: number } {
  if (tr.kind === 'drum' || tr.kind === 'dsyn') {
    // any word is a hit; one starting with a capital is an accent
    return { p: tr.note, v: /^[A-Z]/.test(word) ? 127 : 100 };
  }
  const int = /^-?\d+$/.test(word) ? parseInt(word, 10) : null;
  if (tr.kind === 'slice') {
    if (int === null || int < 0 || int > 63) throw new MiniError(`"${word}" is not a slice number: a sliced track is played with 0, 1, 2…`, col);
    return { p: int, v: 100 };
  }
  if (int !== null) {
    // a bare number is a step of the song's scale, counted from the track's own note
    const p = degreeToPitch(root, type, tr.note, int);
    if (p < 0 || p > 127) throw new MiniError(`"${word}" is out of range`, col);
    return { p, v: 100 };
  }
  const m = NOTE.exec(word);
  if (!m) throw new MiniError(`"${word}" is not a note: write c4, eb3, f#2, or a number for a step of the scale`, col);
  const oct = m[3] !== undefined ? parseInt(m[3], 10) : Math.floor(tr.note / 12) - 1;
  const p = (oct + 1) * 12 + SEMI[m[1].toLowerCase()] + (m[2] === '#' || m[2].toLowerCase() === 's' ? 1 : m[2] === 'b' ? -1 : 0);
  if (p < 0 || p > 127) throw new MiniError(`"${word}" is out of range`, col);
  return { p, v: /^[A-G]/.test(word) ? 127 : 100 };
}

/** One bar's worth of hits for a line, in order: when (0..1 of the bar), how long, pitch, velocity. */
export interface CodeCycle { t: Float64Array; d: Float64Array; p: Int16Array; v: Uint8Array }

export interface CodeLine {
  /** Which line of the text, from 0. */
  line: number;
  track: number;
  /** A bar for each turn before the pattern repeats. Empty if the line has a mistake and never worked. */
  cycles: CodeCycle[];
  error?: { message: string; col: number };
}

export interface CodeInfo { tracks: CodeTrack[]; scaleRoot: number; scaleType: number }

export const codeInfo = (p: Project): CodeInfo => ({ tracks: p.tracks.map((t) => ({ name: t.name, kind: t.kind, note: t.note })), scaleRoot: p.scaleRoot, scaleType: p.scaleType });

/** Something that changes whenever the result of compiling would. */
export const codeKey = (src: string, p: Project): string => `${src}\0${p.scaleRoot},${p.scaleType}\0${p.tracks.map((t) => `${t.name}:${t.kind}:${t.note}`).join('|')}`;

/**
 * Turn the text into lists of hits. A line with a mistake keeps what it played before the mistake was typed
 * (`before` is the last result), so a slip of the finger in the middle of a set doesn't stop the music.
 */
export function compileCode(src: string, info: CodeInfo, before: CodeLine[] = []): CodeLine[] {
  const out: CodeLine[] = [];
  const text = src.slice(0, MAX_CODE).split('\n');
  for (let li = 0; li < text.length; li++) {
    const raw = text[li];
    const cut = raw.indexOf('//');
    const body = cut >= 0 ? raw.slice(0, cut) : raw;
    if (!body.trim()) continue;
    const old = before.find((x) => x.line === li && !x.error);
    const bad = (message: string, col: number, track = old?.track ?? -1): void => {
      out.push({ line: li, track, cycles: old && old.track === track ? old.cycles : [], error: { message, col } });
    };
    const colon = body.indexOf(':');
    if (colon < 0) { bad('a line goes "track: pattern", like "kick: x ~ x ~"', 0); continue; }
    const name = body.slice(0, colon).trim();
    let track = info.tracks.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
    if (track < 0 && /^[1-8]$/.test(name)) track = parseInt(name, 10) - 1;
    if (track < 0 || track >= info.tracks.length) {
      bad(`there is no track called "${name}". The tracks are ${info.tracks.map((t) => t.name.toLowerCase()).join(', ')} (or 1 to ${info.tracks.length})`, 0);
      continue;
    }
    try {
      const tree = new Parser(body.slice(colon + 1), colon + 1).parse();
      const n = period(tree);
      const cycles: CodeCycle[] = [];
      for (let c = 0; c < n; c++) {
        const evs: Ev[] = [];
        lay(tree, c, 0, 1, evs);
        if (evs.length > MAX_EVENTS) throw new MiniError(`that is ${evs.length} notes in one bar; ${MAX_EVENTS} is the most`, colon + 1);
        evs.sort((a, b) => a.b - b.b);
        const cy: CodeCycle = { t: new Float64Array(evs.length), d: new Float64Array(evs.length), p: new Int16Array(evs.length), v: new Uint8Array(evs.length) };
        evs.forEach((e, i) => {
          const m = meaning(e.v, e.col, info.tracks[track], info.scaleRoot, info.scaleType);
          cy.t[i] = Math.max(0, e.b); cy.d[i] = e.e - e.b; cy.p[i] = m.p; cy.v[i] = m.v;
        });
        cycles.push(cy);
      }
      out.push({ line: li, track, cycles });
    } catch (e) {
      if (e instanceof MiniError) bad(e.message, e.col, track);
      else throw e;
    }
  }
  return out;
}

// --- the other way: the grid as text ---------------------------------------

const lower = (pitch: number) => noteName(pitch).toLowerCase().replace('♯', '#');

/** The pattern on screen, written out as code: a line for each track that plays in it. */
export function gridAsCode(p: Project, pattern: number): string {
  const pat = p.patterns[pattern];
  const lines: string[] = [];
  const width = Math.max(...p.tracks.map((t) => t.name.length)) + 1;
  p.tracks.forEach((tr, t) => {
    const cells: string[] = new Array<string>(p.steps).fill('~');
    if (usesNotes(tr.kind)) {
      const notes = (pat.notes[t] ?? []).filter((n) => n.s < p.steps);
      if (!notes.length) return;
      for (let s = 0; s < p.steps; s++) {
        const here = notes.filter((n) => n.s === s);
        if (!here.length) continue;
        const word = (n: (typeof here)[number]) => (tr.kind === 'slice' ? String(n.p) : lower(n.p));
        cells[s] = here.length > 1 ? `[${here.map(word).join(',')}]` : word(here[0]);
        // a long note holds the steps after it, up to the next note
        const len = Math.max(...here.map((n) => n.l));
        for (let k = 1; k < len && s + k < p.steps && !notes.some((n) => n.s === s + k); k++) cells[s + k] = '_';
      }
    } else {
      const row = pat.steps[t];
      if (!row?.slice(0, p.steps).some((v) => v > 0)) return;
      for (let s = 0; s < p.steps; s++) if (row[s]) cells[s] = row[s] > 110 ? 'X' : 'x';
    }
    // in fours, so the beats can be seen
    const beats: string[] = [];
    for (let s = 0; s < p.steps; s += 4) beats.push(cells.slice(s, s + 4).join(' '));
    lines.push(`${`${tr.name.toLowerCase()}:`.padEnd(width + 1)} ${beats.join('  ')}`);
  });
  return lines.join('\n');
}
