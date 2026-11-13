// Learn mode: lessons that are done rather than read, and beats to recreate
// by ear. A lesson opens a beat prepared for it and walks through it with the
// same pointing-and-waiting cards as the first-run walkthrough.

import { importSample, loadHooks, stop, toast } from './actions.svelte';
import { audio } from './audio/host';
import { modRatchet } from './core/creative';
import { CHALLENGES, PASS, blankOf, closeness } from './core/learn';
import { renderProject } from './core/render';
import { TEMPLATES } from './core/templates';
import { newPattern, sanitize, usesSample, type Project } from './core/types';
import { encodeWav } from './core/wav';
import { openAsNew } from './projects.svelte';
import { app } from './state.svelte';
import { loadText, saveText } from './storage';
import { runSteps, startTour, type TourStep } from './tour.svelte';

const KEY = 'loopwell:learn';
const saved = (() => { try { return JSON.parse(loadText(KEY) ?? '{}') as { lessons?: string[]; best?: Record<string, number> }; } catch { return {}; } })();

export const learn = $state({
  /** Lessons finished, by id. */
  lessons: Array.isArray(saved.lessons) ? saved.lessons.filter((x) => typeof x === 'string') : [] as string[],
  /** The best closeness reached on each challenge, 0..1. */
  best: (saved.best && typeof saved.best === 'object' ? saved.best : {}) as Record<string, number>,
  /** The beat being recreated, while a challenge is on. */
  challenge: null as { id: string; target: Project; peeked: boolean; won: boolean } | null,
  /** The target is playing. */
  listening: false,
});

const keep = () => saveText(KEY, JSON.stringify({ lessons: learn.lessons, best: learn.best }));
function lessonDone(id: string): void {
  if (!learn.lessons.includes(id)) learn.lessons.push(id);
  keep();
}

// --- lessons ---------------------------------------------------------------

const pat = () => app.project.patterns[app.pat];
const hats = () => pat()?.steps[3] ?? [];
const rolled = () => hats().map((v, s) => (v > 0 && modRatchet(pat().mods[3]?.[s] ?? 0) >= 2 ? s : -1)).filter((s) => s >= 0);
const duck = () => app.project.tracks[6]?.fx.find((f) => f.type === 'duck');
const grid = () => { app.perform = app.stage = false; app.project.songMode = false; };

/** One pattern of a template, as the place a lesson starts from. */
function starter(index: number, name: string, edit: (p: Project) => void): Project {
  const p = sanitize(TEMPLATES[index].make());
  p.name = name;
  for (let i = 1; i < p.patterns.length; i++) p.patterns[i] = newPattern(p.tracks.length);
  edit(p);
  return sanitize(p);
}

async function hatLesson(): Promise<void> {
  await openAsNew(starter(0, 'Trap hi-hats', (p) => {
    p.patterns[0].steps[3].fill(0);
    p.patterns[0].steps[4].fill(0);
    p.patterns[0].mods[3].fill(0);
  }), 'Started a lesson');
  const steps: TourStep[] = [
    {
      title: 'Straight eighths first',
      text: 'The drums are here; the hi-hats are yours. Put a HAT on every other step, starting with the first: steps 1, 3, 5 and so on to 15. Press and drag along the row to paint them.',
      target: '.row[data-row="3"] .cells',
      done: () => [0, 2, 4, 6, 8, 10, 12, 14].every((s) => hats()[s] > 0),
      enter: () => { grid(); app.sel = 3; },
    },
    { title: 'Hear it', text: 'Press play, or the space bar. Steady, and a bit stiff. The rolls are what fix that.', target: '.tbtn.play', done: () => app.playing },
    {
      title: 'Pick a hat to roll',
      text: 'Right-click one of your hats near the end of the bar (or press and hold it). That picks the step, and its settings open in Tools.',
      target: '.row[data-row="3"] .cells',
      done: () => app.step?.t === 3 && hats()[app.step.s] > 0,
    },
    {
      title: 'Roll it',
      text: 'Under Roll, choose ×3. That one step now plays three quick hits in the time of one: the triplet stutter trap is known for.',
      target: '.tools section',
      done: () => rolled().length >= 1,
      enter: () => { app.tab = 'tools'; },
    },
    {
      title: 'And another, somewhere else',
      text: 'Pick a different hat the same way and give it a roll too. Try ×2 or ×4. Rolls work best just before a kick or the clap.',
      target: '.row[data-row="3"] .cells',
      done: () => rolled().length >= 2,
    },
    {
      title: 'Make them breathe',
      text: 'Hats all at one loudness sound like a machine. Drag a few of them downwards to make them quieter, so that some are loud and some are soft.',
      target: '.row[data-row="3"] .cells',
      done: () => hats().some((v) => v > 0 && v <= 80) && hats().some((v) => v >= 100),
    },
  ];
  runSteps('hats', 'Trap hi-hats', steps, { title: 'That is a trap hi-hat pattern', text: 'Eighths for the pulse, rolls for the bounce, and loud and soft for the feel. The same three moves work on any drum: try a roll on the snare at the end of the bar.' }, () => lessonDone('hats'));
}

async function sidechainLesson(): Promise<void> {
  await openAsNew(starter(1, 'Sidechain a bass', (p) => {
    // long notes, so the pumping can be heard
    p.patterns[0].notes[6] = [{ s: 0, l: 8, p: 36, v: 110 }, { s: 8, l: 8, p: 34, v: 110 }];
    p.tracks[6].fx = p.tracks[6].fx.filter((f) => f.type !== 'duck');
    p.tracks[6].vol = 110;
  }), 'Started a lesson');
  const steps: TourStep[] = [
    { title: 'Listen first', text: 'Press play. The bass holds long notes, and every kick has to fight it for the low end. That muddiness is what sidechaining clears up.', target: '.tbtn.play', done: () => app.playing, enter: grid },
    { title: 'Select the bass', text: 'Click BASS. The effect goes on the track that should get out of the way.', target: '.row[data-row="6"] .head', done: () => app.sel === 6 },
    { title: 'Open its effect rack', text: 'Every track has a rack of effects of its own. Open the Rack tab.', target: '.tabs', done: () => app.tab === 'rack' },
    { title: 'Add a Sidechain', text: 'Press Sidechain to add one. It listens to another track, and turns this one down whenever that track plays. It has already picked the kick to listen to.', target: '.rack', done: () => !!duck() },
    { title: 'Turn it up until it pumps', text: 'Drag the Amount knob up, most of the way. Hear the bass duck under each kick and swell back up? That is the sound.', target: '.rack', done: () => (duck()?.p[2] ?? 0) >= 110 },
    { title: 'Set how fast it comes back', text: 'Release is how long the bass takes to return. Short is tight and punchy; long is the slow breathing of French house. Move it and listen.', target: '.rack', done: () => { const d = duck(); return !!d && d.p[3] !== 50; } },
  ];
  runSteps('sidechain', 'Sidechain a bass', steps, { title: 'The bass now makes room for the kick', text: 'Sidechaining works on anything that should move with the drums: pads, chords, a whole group. Point the Source knob at a different track to duck to that instead.' }, () => lessonDone('sidechain'));
}

/** A two-bar drum break, played by the engine and handed back as a recording: something to chop that needs no download. */
async function makeBreak(): Promise<File> {
  const src = sanitize(TEMPLATES[2].make()); // boom bap
  for (const t of [6, 7]) src.tracks[t].mute = true;
  await audio.init();
  await Promise.all(src.tracks.filter((t) => usesSample(t.kind)).map((t) => audio.ensure(t.sample)));
  const out = await renderProject(src, audio.bank, { sampleRate: audio.sampleRate, chain: [0, 1], maxTail: 0.4 });
  return new File([encodeWav([out.l, out.r], out.sampleRate, 16)], 'break.wav', { type: 'audio/wav' });
}

async function chopLesson(): Promise<void> {
  const file = await makeBreak();
  await openAsNew(starter(2, 'Chop a sample', (p) => {
    p.patterns[0] = newPattern(p.tracks.length);
    p.patterns[0].steps[0] = p.patterns[0].steps[0].map((_, s) => (s === 0 || s === 10 ? 110 : 0));
    p.tracks[5].vol = 100; p.tracks[5].rev = 0; p.tracks[5].pan = 0;
  }), 'Started a lesson');
  if (!(await importSample(file, 5))) { toast('The lesson\'s drum break could not be made on this device.', 'error'); return; }
  const tr = () => app.project.tracks[5];
  const notes = () => pat()?.notes[5] ?? [];
  const steps: TourStep[] = [
    { title: 'Meet the break', text: 'The track called BREAK holds two bars of drums as one long recording. Click its name to select it; its pad plays the whole thing.', target: '.row[data-row="5"] .head', done: () => app.sel === 5, enter: () => { grid(); app.tab = 'sound'; } },
    { title: 'Turn it into slices', text: 'On the Sound tab, switch this track from Drum to Slice. Loopwell finds the hits in the recording and cuts it at each one.', target: '.sound .seg', done: () => tr()?.kind === 'slice', enter: () => { app.tab = 'sound'; } },
    { title: 'Look at the cuts', text: 'Each line on the waveform is the start of a slice. Auto finds the hits; 4, 8 and 16 cut it into equal pieces instead. Try 8, then go back to Auto if you like it better.', target: '.sampler', done: () => (tr()?.slices.length ?? 0) >= 4 },
    { title: 'Play the pieces in a new order', text: 'Open Keys. Each row is a slice now. Click to put down at least four notes, using three or more different slices: you are rearranging the drummer.', target: '.roll .scroller', done: () => notes().length >= 4 && new Set(notes().map((n) => n.p)).size >= 3, enter: () => { app.tab = 'keys'; } },
    { title: 'Hear your chop', text: 'Press play. Same drums, your rhythm.', target: '.tbtn.play', done: () => app.playing },
  ];
  runSteps('chop', 'Chop a sample', steps, { title: 'You chopped a break', text: 'This is how whole genres were made. Drop any recording of your own on a track (or split a song into stems under Export) and chop it the same way.' }, () => lessonDone('chop'));
}

export interface Lesson { id: string; name: string; blurb: string; minutes: number; start: () => Promise<void> }

export const LESSONS: Lesson[] = [
  { id: 'first', name: 'Your first beat', blurb: 'Kick, clap, hats, a bassline and some swing, from nothing.', minutes: 3, start: startTour },
  { id: 'hats', name: 'A trap hi-hat pattern', blurb: 'Eighths, triplet rolls and loud-and-soft: what makes hats bounce.', minutes: 3, start: hatLesson },
  { id: 'sidechain', name: 'Sidechain a bass', blurb: 'Make the bass duck out of the kick\'s way, and pump.', minutes: 2, start: sidechainLesson },
  { id: 'chop', name: 'Chop a sample', blurb: 'Slice a drum break and play the pieces in a new order.', minutes: 3, start: chopLesson },
];

export async function startLesson(id: string): Promise<void> {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) return;
  endChallenge();
  stop();
  await l.start();
}

// --- recreate this beat ----------------------------------------------------

let player: AudioBufferSourceNode | null = null;

export async function startChallenge(id: string): Promise<void> {
  const c = CHALLENGES.find((x) => x.id === id);
  if (!c) return;
  stopListening();
  stop();
  app.tour = -1;
  const target = sanitize(c.make());
  await openAsNew(sanitize(blankOf(target, `${c.name} (my go)`)), 'Started a challenge');
  learn.challenge = { id, target, peeked: false, won: false };
  app.modal = null;
  app.perform = app.stage = false;
  app.tab = 'sound';
  app.pat = 0;
  void listen();
}

export function endChallenge(): void {
  stopListening();
  learn.challenge = null;
}

// opening any other beat leaves the challenge: what is on screen is no longer an attempt at it
loadHooks.push(() => { if (learn.challenge) endChallenge(); });

export function stopListening(): void {
  if (player) { player.onended = null; try { player.stop(); } catch { /* not started */ } player.disconnect(); player = null; }
  learn.listening = false;
}

/** Play the beat to recreate: twice round, so there is time to take it in. */
export async function listen(): Promise<void> {
  const c = learn.challenge;
  if (!c) return;
  if (learn.listening) { stopListening(); return; }
  stop();
  learn.listening = true;
  try {
    await audio.init();
    await audio.resume();
    await Promise.all(c.target.tracks.filter((t) => usesSample(t.kind)).map((t) => audio.ensure(t.sample)));
    const out = await renderProject(c.target, audio.bank, { sampleRate: audio.sampleRate, chain: [0, 0], maxTail: 1 });
    const ctx = audio.ctx;
    if (!ctx || learn.challenge !== c || !learn.listening) { learn.listening = false; return; }
    const buf = ctx.createBuffer(2, out.l.length, out.sampleRate);
    buf.getChannelData(0).set(out.l);
    buf.getChannelData(1).set(out.r);
    player = ctx.createBufferSource();
    player.buffer = buf;
    player.connect(ctx.destination);
    player.onended = () => { player = null; learn.listening = false; };
    player.start();
  } catch {
    learn.listening = false;
  }
}

/** How close the beat on screen is, and note it down if it is the best yet. Called as the beat changes. */
export function judge(): ReturnType<typeof closeness> | null {
  const c = learn.challenge;
  if (!c) return null;
  return closeness(c.target, app.project, 0, app.pat);
}

export function record(score: number): void {
  const c = learn.challenge;
  if (!c) return;
  if (score > (learn.best[c.id] ?? 0)) { learn.best[c.id] = Math.round(score * 1000) / 1000; keep(); }
  if (score >= PASS && !c.won) c.won = true;
}

export function nextChallenge(): string | null {
  const i = CHALLENGES.findIndex((x) => x.id === learn.challenge?.id);
  return CHALLENGES[i + 1]?.id ?? null;
}
